"""Playlist panel: the list itself is the model (one QListWidgetItem per entry)."""

from __future__ import annotations

import itertools
import os
import queue
import random
import shutil
import subprocess
import threading

from PySide6.QtCore import QRectF, QSize, Qt, Signal
from PySide6.QtGui import QFontMetrics, QPainter
from PySide6.QtWidgets import (
    QAbstractItemView,
    QListWidget,
    QListWidgetItem,
    QMenu,
    QStyle,
    QStyledItemDelegate,
    QWidget,
)

from . import skin
from .util import fmt_time, is_url, natural_key, title_of
from .widgets import IconButton

PATH_ROLE = Qt.UserRole
DURATION_ROLE = Qt.UserRole + 1
TOKEN_ROLE = Qt.UserRole + 2
ROW_H = 22
HEADER_H = 26
FOOTER_H = 27


class _DurationProber(threading.Thread):
    """Fills in durations with ffprobe in the background (skipped when ffprobe is missing).

    Jobs are ``(token, path)`` pairs: the token identifies the concrete playlist entry that asked
    for the probe, so a late result can never be attributed to a different entry. ``stop()`` makes
    the worker drop anything still queued and abort a running ffprobe, so shutdown stays bounded.
    """

    def __init__(self, callback, probe=None, timeout=15):
        super().__init__(daemon=True, name="playlist-duration-prober")
        self.jobs: queue.Queue = queue.Queue()
        self.callback = callback
        self.probe = probe
        self.timeout = timeout
        self.ffprobe = shutil.which("ffprobe")
        self.available = probe is not None or bool(self.ffprobe)
        self._halted = threading.Event()
        self._lock = threading.Lock()
        self._proc = None

    def run(self):
        while not self._halted.is_set():
            job = self.jobs.get()
            if job is None or self._halted.is_set():
                return
            token, path = job
            try:
                duration = self._measure(path)
                if duration and not self._halted.is_set():
                    self.callback(token, duration)
            except Exception:
                continue

    def _measure(self, path) -> float | None:
        if self.probe is not None:
            value = self.probe(path)
            return float(value) if value else None
        if not self.ffprobe:
            return None
        # Starting happens under the lock so stop() either sees the process (and kills it) or
        # prevents it from being started at all.
        with self._lock:
            if self._halted.is_set():
                return None
            proc = subprocess.Popen(
                [self.ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
            )
            self._proc = proc
        if self._halted.is_set():
            proc.kill()
            return None
        try:
            out, _ = proc.communicate(timeout=self.timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            return None
        finally:
            with self._lock:
                self._proc = None
        try:
            return float(out.strip())
        except ValueError:
            return None

    def stop(self, timeout=1.0):
        self._halted.set()
        self.jobs.put(None)  # wake the worker if it is waiting for a job
        with self._lock:
            proc = self._proc
        if proc is not None:
            try:
                proc.kill()  # unblock communicate() so stop stays prompt
            except OSError:
                pass
        if self.is_alive() and self is not threading.current_thread():
            self.join(timeout)


class _Delegate(QStyledItemDelegate):
    def __init__(self, panel):
        super().__init__(panel)
        self.panel = panel
        self.font = skin.font(12)

    def sizeHint(self, option, index):
        return QSize(100, ROW_H)

    def paint(self, p: QPainter, option, index):
        rect = option.rect
        item = self.panel.view.item(index.row())
        current = item is self.panel.current_item
        if option.state & QStyle.State_Selected:
            p.fillRect(rect, skin.SELECT)
        elif option.state & QStyle.State_MouseOver:
            p.fillRect(rect, skin.BG_HOVER)
        p.setFont(self.font)
        fm = QFontMetrics(self.font)
        color = skin.ACCENT if current else skin.TEXT
        duration = index.data(DURATION_ROLE)
        right = rect.right() - 8
        if duration:
            text = fmt_time(duration)
            w = fm.horizontalAdvance(text)
            p.setPen(skin.ACCENT if current else skin.TEXT_DIM)
            p.drawText(QRectF(right - w, rect.top(), w + 2, rect.height()), Qt.AlignVCenter, text)
            right -= w + 10
        number = "%d." % (index.row() + 1)
        num_w = max(fm.horizontalAdvance("00."), fm.horizontalAdvance(number))
        p.setPen(skin.ACCENT if current else skin.TEXT_DIM)
        p.drawText(QRectF(rect.left() + 8, rect.top(), num_w, rect.height()), Qt.AlignVCenter | Qt.AlignRight, number)
        left = rect.left() + 8 + num_w + 7
        p.setPen(color)
        title = fm.elidedText(index.data(Qt.DisplayRole) or "", Qt.ElideRight, max(10, right - left))
        p.drawText(
            QRectF(left, rect.top(), max(10, right - left), rect.height()), Qt.AlignVCenter | Qt.AlignLeft, title
        )


class _List(QListWidget):
    def __init__(self, panel):
        super().__init__(panel)
        self.panel = panel

    def keyPressEvent(self, event):
        key = event.key()
        if key in (Qt.Key_Return, Qt.Key_Enter):
            row = self.currentRow()
            if row >= 0:
                self.panel.playRequested.emit(row)
            event.accept()
        elif key == Qt.Key_Delete:
            self.panel.remove_selected()
            event.accept()
        elif key == Qt.Key_Escape:
            self.clearSelection()
            self.clearFocus()
            self.window().setFocus()
            event.accept()
        elif key in (Qt.Key_Up, Qt.Key_Down, Qt.Key_Home, Qt.Key_End, Qt.Key_PageUp, Qt.Key_PageDown) and not (
            event.modifiers() & (Qt.ControlModifier | Qt.AltModifier)
        ):
            super().keyPressEvent(event)
        elif key == Qt.Key_A and event.modifiers() == Qt.ControlModifier:
            self.selectAll()
            event.accept()
        else:
            event.ignore()  # everything else stays a global player shortcut

    def dropEvent(self, event):
        current_token = self.panel._token_of_current()
        super().dropEvent(event)  # Qt's internal move rebuilds the items from mime data
        self.panel._adopt_rebuilt_view(current_token)
        self.panel.changed.emit()


class TextButton(QWidget):
    clicked = Signal()

    def __init__(self, text: str, parent=None):
        super().__init__(parent)
        self.text = text
        self._hover = False
        self._font = skin.font(12)
        self.setFixedSize(QFontMetrics(self._font).horizontalAdvance(text) + 20, FOOTER_H - 1)
        self.setFocusPolicy(Qt.NoFocus)

    def enterEvent(self, event):
        self._hover = True
        self.update()

    def leaveEvent(self, event):
        self._hover = False
        self.update()

    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton:
            self.clicked.emit()
        event.accept()

    def paintEvent(self, event):
        p = QPainter(self)
        p.fillRect(self.rect(), skin.BG_HOVER if self._hover else skin.BG)
        p.setFont(self._font)
        p.setPen(skin.TEXT_BRIGHT if self._hover else skin.TEXT)
        p.drawText(self.rect(), Qt.AlignCenter, self.text)


class PlaylistPanel(QWidget):
    playRequested = Signal(int)
    addFilesRequested = Signal()
    addFolderRequested = Signal()
    addUrlRequested = Signal()
    closeRequested = Signal()
    repeatClicked = Signal()
    shuffleClicked = Signal()
    changed = Signal()
    _durationReady = Signal(int, float)

    def __init__(self, parent=None, probe=None):
        super().__init__(parent)
        self.current_item: QListWidgetItem | None = None
        # Live entries by token: token -> item. A probe result is accepted only while its token is
        # still here and still belongs to the very same item object.
        self._entries: dict[int, QListWidgetItem] = {}
        self._next_token = itertools.count(1)
        self._closed = False
        self.view = _List(self)
        self.view.setItemDelegate(_Delegate(self))
        self.view.setFrameShape(QListWidget.NoFrame)
        self.view.setFocusPolicy(Qt.ClickFocus)
        self.view.setMouseTracking(True)
        self.view.setUniformItemSizes(True)
        self.view.setSelectionMode(QAbstractItemView.ExtendedSelection)
        self.view.setDragDropMode(QAbstractItemView.InternalMove)
        self.view.setDefaultDropAction(Qt.MoveAction)
        self.view.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.view.setVerticalScrollMode(QAbstractItemView.ScrollPerPixel)
        self.view.setContextMenuPolicy(Qt.CustomContextMenu)
        self.view.customContextMenuRequested.connect(self._context_menu)
        self.view.itemDoubleClicked.connect(lambda item: self.playRequested.emit(self.view.row(item)))
        self.view.setStyleSheet("QListWidget { background: %s; border: none; outline: none; }" % skin.PANEL.name())
        self.close_btn = IconButton("close", 26, HEADER_H, "Close playlist (F6)", color=skin.ICON_DIM, parent=self)
        self.close_btn.flat = True
        self.close_btn.clicked.connect(self.closeRequested)
        self.add_btn = TextButton("Add", self)
        self.del_btn = TextButton("Del", self)
        self.sort_btn = TextButton("Sort", self)
        self.add_btn.clicked.connect(self._add_menu)
        self.del_btn.clicked.connect(self._del_menu)
        self.sort_btn.clicked.connect(self._sort_menu)
        self.repeat_btn = IconButton("repeat", 28, FOOTER_H - 1, "Repeat: off", color=skin.ICON_DIM, parent=self)
        self.shuffle_btn = IconButton("shuffle", 28, FOOTER_H - 1, "Shuffle", color=skin.ICON_DIM, parent=self)
        self.repeat_btn.clicked.connect(self.repeatClicked)
        self.shuffle_btn.clicked.connect(self.shuffleClicked)
        self.repeat_mode = "off"
        self._durationReady.connect(self._set_duration)
        self._prober = _DurationProber(self._durationReady.emit, probe=probe)
        if self._prober.available:
            self._prober.start()

    # -- layout / paint --------------------------------------------------------------------------
    def resizeEvent(self, event):
        w, h = self.width(), self.height()
        self.close_btn.move(w - 26, 0)
        self.view.setGeometry(0, HEADER_H + 1, w, max(0, h - HEADER_H - 1 - FOOTER_H))
        y = h - FOOTER_H + 1
        x = 0
        for btn in (self.add_btn, self.del_btn, self.sort_btn):
            btn.move(x, y)
            x += btn.width() + 1
        self.shuffle_btn.move(w - 28, y)
        self.repeat_btn.move(w - 57, y)

    def paintEvent(self, event):
        p = QPainter(self)
        w, h = self.width(), self.height()
        p.fillRect(self.rect(), skin.BG)
        p.fillRect(0, HEADER_H, w, 1, skin.LINE)
        p.fillRect(0, h - FOOTER_H, w, 1, skin.LINE)
        p.setFont(skin.font(12))
        fm = p.fontMetrics()
        label = "Playlist"
        label_w = fm.horizontalAdvance(label) + 24
        p.fillRect(0, 0, label_w, HEADER_H, skin.PANEL)
        p.fillRect(0, HEADER_H - 2, label_w, 2, skin.ACCENT)
        p.fillRect(label_w, 0, 1, HEADER_H, skin.LINE)
        p.setPen(skin.TEXT_BRIGHT)
        p.drawText(QRectF(0, 0, label_w, HEADER_H - 1), Qt.AlignCenter, label)
        count = self.view.count()
        if count:
            total = sum(self.view.item(i).data(DURATION_ROLE) or 0 for i in range(count))
            info = "%d item%s" % (count, "" if count == 1 else "s")
            if total:
                info += "  ·  " + fmt_time(total)
            p.setPen(skin.TEXT_DIM)
            p.drawText(QRectF(label_w + 10, 0, w - label_w - 40, HEADER_H - 1), Qt.AlignVCenter | Qt.AlignLeft, info)
        x = 0
        for btn in (self.add_btn, self.del_btn, self.sort_btn):
            x += btn.width()
            p.fillRect(x, h - FOOTER_H + 1, 1, FOOTER_H - 1, skin.LINE)
            x += 1

    # -- model -----------------------------------------------------------------------------------
    def count(self) -> int:
        return self.view.count()

    def path(self, row: int) -> str | None:
        item = self.view.item(row)
        return item.data(PATH_ROLE) if item else None

    def paths(self) -> list[str]:
        return [self.view.item(i).data(PATH_ROLE) for i in range(self.view.count())]

    def current_row(self) -> int:
        return self.view.row(self.current_item) if self.current_item is not None else -1

    def _make_item(self, path: str) -> QListWidgetItem:
        item = QListWidgetItem(title_of(path))
        token = next(self._next_token)
        item.setData(PATH_ROLE, path)
        item.setData(TOKEN_ROLE, token)
        item.setToolTip(path)
        self._entries[token] = item
        if self._prober.available and not self._closed and not is_url(path):
            self._prober.jobs.put((token, path))
        return item

    def _forget(self, token: int):
        """Drop a token so any in-flight probe result for it is ignored from now on."""
        self._entries.pop(token, None)

    def _discard_all(self):
        """Invalidate every pending probe: the list these tokens belonged to no longer exists."""
        self._entries.clear()

    def _reindex(self):
        """Rebuild token -> item from the view (Qt re-creates items on internal drag/drop)."""
        live: dict[int, QListWidgetItem] = {}
        for i in range(self.view.count()):
            item = self.view.item(i)
            token = item.data(TOKEN_ROLE)
            if token is not None:
                live[token] = item
        self._entries = live

    def _token_of_current(self) -> int | None:
        try:
            return self.current_item.data(TOKEN_ROLE) if self.current_item is not None else None
        except RuntimeError:  # the C++ item may already be gone
            return None

    def _adopt_rebuilt_view(self, current_token: int | None):
        self._reindex()
        self.current_item = self._entries.get(current_token) if current_token is not None else None

    def set_items(self, paths: list[str]):
        self._discard_all()
        self.view.clear()
        self.current_item = None
        for path in paths:
            self.view.addItem(self._make_item(path))
        self._refresh()

    def add(self, paths: list[str]) -> int:
        first = self.view.count()
        for path in paths:
            self.view.addItem(self._make_item(path))
        self._refresh()
        return first

    def set_current(self, row: int):
        self.current_item = self.view.item(row) if row >= 0 else None
        if self.current_item is not None:
            self.view.scrollToItem(self.current_item)
        self.view.viewport().update()

    def _set_duration(self, token: int, duration: float):
        if self._closed:
            return
        item = self._entries.get(token)
        if item is None:
            return  # the entry was removed or the list was rebuilt: late result is stale
        try:
            if item.data(TOKEN_ROLE) != token:
                return
            if self.view.row(item) < 0:
                self._forget(token)  # dropped from the view by Qt without notice
                return
            if not item.data(DURATION_ROLE):
                item.setData(DURATION_ROLE, duration)
                self.view.viewport().update()
                self.update()
        except RuntimeError:
            # The underlying C++ item is already gone (Qt destroyed it during a drag/drop move).
            self._forget(token)

    def set_duration(self, path: str, duration: float):
        """Apply a real (mpv) duration to every live entry with this path that has none yet."""
        if not duration or self._closed:
            return
        duration = float(duration)
        changed = False
        for i in range(self.view.count()):
            item = self.view.item(i)
            if item.data(PATH_ROLE) == path and not item.data(DURATION_ROLE):
                item.setData(DURATION_ROLE, duration)
                changed = True
        if changed:
            self.view.viewport().update()
            self.update()

    def remove_selected(self):
        for item in self.view.selectedItems():
            if item is self.current_item:
                self.current_item = None
            self._forget(item.data(TOKEN_ROLE))
            self.view.takeItem(self.view.row(item))
        self._refresh()

    def clear(self):
        self._discard_all()
        self.view.clear()
        self.current_item = None
        self._refresh()

    def sort_by(self, key: str):
        entries = []
        while self.view.count():
            item = self.view.takeItem(0)  # detach without deleting: entries keep their tokens
            entries.append(item)
        current = self.current_item.data(TOKEN_ROLE) if self.current_item is not None else None
        if key == "name":
            entries.sort(key=lambda e: natural_key(title_of(e.data(PATH_ROLE))))
        elif key == "path":
            entries.sort(key=lambda e: natural_key(e.data(PATH_ROLE)))
        elif key == "duration":
            entries.sort(key=lambda e: e.data(DURATION_ROLE) or 0)
        elif key == "reverse":
            entries.reverse()
        elif key == "random":
            random.shuffle(entries)
        # The same item objects are re-inserted, so tokens stay valid and in-flight probes still land
        # on the entry that asked for them, wherever the sort moved it.
        self.current_item = None
        for item in entries:
            self.view.addItem(item)
            if item.data(TOKEN_ROLE) == current:
                self.current_item = item
        self._reindex()
        self._refresh()

    def step(self, direction: int, repeat: str, shuffle: bool) -> int:
        """Row to play after the current one, or -1 when the list is exhausted."""
        count = self.view.count()
        if count == 0:
            return -1
        row = self.current_row()
        if shuffle and count > 1:
            choices = [i for i in range(count) if i != row]
            return random.choice(choices)
        nxt = row + direction
        if 0 <= nxt < count:
            return nxt
        if repeat == "all":
            return nxt % count
        return -1

    def set_modes(self, repeat: str, shuffle: bool):
        self.repeat_mode = repeat
        self.repeat_btn.set_checked(repeat != "off")
        self.repeat_btn.setToolTip(
            {"off": "Repeat: off", "one": "Repeat: current file", "all": "Repeat: playlist"}[repeat]
        )
        self.shuffle_btn.set_checked(shuffle)

    def _refresh(self):
        self.update()
        self.view.viewport().update()
        self.changed.emit()

    # -- menus -----------------------------------------------------------------------------------
    def _add_menu(self):
        menu = QMenu(self)
        menu.addAction("Add Files...", self.addFilesRequested.emit)
        menu.addAction("Add Folder...", self.addFolderRequested.emit)
        menu.addAction("Add URL...", self.addUrlRequested.emit)
        self._exec_above(menu, self.add_btn)

    def _del_menu(self):
        menu = QMenu(self)
        menu.addAction("Remove Selected\tDel", self.remove_selected)
        menu.addAction("Remove Missing Files", self._remove_missing)
        menu.addAction("Remove Duplicates", self._remove_duplicates)
        menu.addSeparator()
        menu.addAction("Clear Playlist", self.clear)
        self._exec_above(menu, self.del_btn)

    def _sort_menu(self):
        menu = QMenu(self)
        menu.addAction("By Name", lambda: self.sort_by("name"))
        menu.addAction("By Path", lambda: self.sort_by("path"))
        menu.addAction("By Duration", lambda: self.sort_by("duration"))
        menu.addSeparator()
        menu.addAction("Reverse", lambda: self.sort_by("reverse"))
        menu.addAction("Randomize", lambda: self.sort_by("random"))
        self._exec_above(menu, self.sort_btn)

    def _exec_above(self, menu: QMenu, widget: QWidget):
        pos = widget.mapToGlobal(widget.rect().topLeft())
        pos.setY(pos.y() - menu.sizeHint().height())
        menu.exec(pos)

    def _remove_missing(self):
        for i in reversed(range(self.view.count())):
            item = self.view.item(i)
            path = item.data(PATH_ROLE)
            if not is_url(path) and not os.path.exists(path):
                if item is self.current_item:
                    self.current_item = None
                self._forget(item.data(TOKEN_ROLE))
                self.view.takeItem(i)
        self._refresh()

    def _remove_duplicates(self):
        seen = set()
        i = 0
        while i < self.view.count():
            item = self.view.item(i)
            path = item.data(PATH_ROLE)
            if path in seen:
                if item is self.current_item:
                    self.current_item = None
                self._forget(item.data(TOKEN_ROLE))
                self.view.takeItem(i)
            else:
                seen.add(path)
                i += 1
        self._refresh()

    def _context_menu(self, pos):
        row = self.view.row(self.view.itemAt(pos)) if self.view.itemAt(pos) else -1
        menu = QMenu(self)
        act = menu.addAction("Play\tEnter", lambda: self.playRequested.emit(row))
        act.setEnabled(row >= 0)
        menu.addSeparator()
        menu.addAction("Add Files...", self.addFilesRequested.emit)
        menu.addAction("Add Folder...", self.addFolderRequested.emit)
        menu.addAction("Add URL...", self.addUrlRequested.emit)
        menu.addSeparator()
        act = menu.addAction("Remove\tDel", self.remove_selected)
        act.setEnabled(bool(self.view.selectedItems()))
        menu.addAction("Remove Missing Files", self._remove_missing)
        menu.addAction("Remove Duplicates", self._remove_duplicates)
        menu.addAction("Clear Playlist", self.clear)
        menu.addSeparator()
        sort = menu.addMenu("Sort By")
        sort.addAction("Name", lambda: self.sort_by("name"))
        sort.addAction("Path", lambda: self.sort_by("path"))
        sort.addAction("Duration", lambda: self.sort_by("duration"))
        sort.addSeparator()
        sort.addAction("Reverse Order", lambda: self.sort_by("reverse"))
        menu.addSeparator()
        act = menu.addAction("Copy Path", lambda: self._copy_path(row))
        act.setEnabled(row >= 0)
        act = menu.addAction("Show in File Manager", lambda: self._show_in_folder(row))
        act.setEnabled(row >= 0 and not is_url(self.path(row) or ""))
        menu.exec(self.view.viewport().mapToGlobal(pos))

    def _copy_path(self, row: int):
        from PySide6.QtGui import QGuiApplication

        path = self.path(row)
        if path:
            QGuiApplication.clipboard().setText(path)

    def _show_in_folder(self, row: int):
        from PySide6.QtCore import QUrl
        from PySide6.QtGui import QDesktopServices

        path = self.path(row)
        if path:
            QDesktopServices.openUrl(QUrl.fromLocalFile(os.path.dirname(path)))

    def shutdown(self, timeout=1.0):
        """Stop the prober and make sure no queued/late result can touch the list again."""
        if self._closed:
            return
        self._closed = True
        self._prober.stop(timeout=timeout)
        self._entries.clear()
        try:
            self._durationReady.disconnect(self._set_duration)  # drop any queued emission
        except RuntimeError:
            pass
