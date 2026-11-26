import { type Joystick } from './stores/joysticksStore'

const { sin, cos, sqrt, pow, atan2 } = Math
const pi = Math.PI

export type JoystickAreaProps = {
  joystick: Joystick
  mode?: 'origin' | 'follow'
  element: HTMLElement
  maxFollowDistance?: number
  maxOriginDistance?: number
  onStart?: (joystick: Joystick) => void
  onMove?: (joystick: Joystick) => void
  onEnd?: (joystick: Joystick) => void
}

export const mountJoystickArea = ({
  joystick,
  mode = 'follow',
  maxFollowDistance = 50,
  maxOriginDistance = 50,
  element,
  onStart,
  onEnd,
  onMove,
}: JoystickAreaProps) => {
  if (!joystick) {
    console.error('JoystickArea: an joystick object is required')
  }

  let resetMovementTimeout: ReturnType<typeof setTimeout> | null = null
  let endResetTimeout: ReturnType<typeof setTimeout> | null = null
  // Incremented for every newly claimed touch session and when the area is
  // unmounted. Reset timers capture the session they were scheduled in so a
  // stale timer can never clear a newer session, even if the browser reuses
  // the same touch identifier (for example `0`).
  let session = 0
  let disposed = false

  const resetJoystick = () => {
    if (!joystick) {
      return
    }
    joystick.identifier = null
    joystick.isActive = false
    joystick.origin.x = null
    joystick.origin.y = null
    joystick.origin.angle = null
    joystick.origin.distance = null
    joystick.origin.distanceRatio = null
    joystick.follow.x = null
    joystick.follow.y = null
    joystick.follow.angle = null
    joystick.follow.distance = null
    joystick.follow.distanceRatio = null
    joystick.current.x = null
    joystick.current.y = null
    joystick.movement.x = 0
    joystick.movement.y = 0
  }

  // Supports both a real TouchList (`item(index)`) and plain array / array-like
  // touch collections used in hand-rolled DOM event samples.
  const getTouchAt = (list: TouchList | null | undefined, index: number): Touch | null => {
    if (!list) {
      return null
    }
    if (typeof list.item === 'function') {
      return list.item(index)
    }
    return list[index] ?? null
  }

  const handleTouchStart = (e: TouchEvent) => {
    e.preventDefault()

    if (disposed) {
      return
    }

    const touch = getTouchAt(e.changedTouches, 0)

    if (!touch || !joystick) {
      return
    }

    // `identifier` is `null` exactly while no touch is bound. A touch
    // identifier of `0` is a valid active touch, so checks must be against
    // `null` rather than loose `!= undefined` / truthiness.
    // `endResetTimeout` being set means the bound touch has already ended and
    // its values are only retained until the delayed reset. During that
    // window a new touch is allowed to claim the joystick immediately.
    const hasActiveTouch = joystick.identifier !== null && endResetTimeout === null

    if (hasActiveTouch) {
      return
    }

    // Cancel the pending reset of the previous (already ended) session so it
    // cannot wipe the new session, and drop its stale movement reset.
    if (endResetTimeout !== null) {
      clearTimeout(endResetTimeout)
      endResetTimeout = null
    }
    if (resetMovementTimeout !== null) {
      clearTimeout(resetMovementTimeout)
      resetMovementTimeout = null
    }

    session += 1

    const target = e.target as HTMLElement
    const rect = target.getBoundingClientRect()
    const currentX = touch.clientX - rect.left
    const currentY = rect.height - (touch.clientY - rect.top)

    joystick.identifier = touch.identifier
    joystick.isActive = true
    joystick.origin.x = currentX
    joystick.origin.y = currentY
    joystick.origin.angle = 0
    joystick.origin.distance = 0
    joystick.origin.distanceRatio = 0

    if (mode === 'follow') {
      joystick.follow.x = currentX
      joystick.follow.y = currentY
      joystick.follow.angle = 0
      joystick.follow.distance = 0
      joystick.follow.distanceRatio = 0
    }

    joystick.current.x = currentX
    joystick.current.y = currentY
    joystick.movement.x = 0
    joystick.movement.y = 0

    onStart?.(joystick)
  }

  const handleTouchMove = (e: TouchEvent) => {
    e.preventDefault()

    if (disposed || !joystick) {
      return
    }

    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = getTouchAt(e.changedTouches, i)

      if (!touch || joystick.identifier !== touch.identifier) {
        continue
      }

      if (
        joystick.origin.x === null ||
        joystick.origin.y === null ||
        joystick.current.x === null ||
        joystick.current.y === null
      ) {
        continue
      }

      const target = e.target as HTMLElement
      const rect = target.getBoundingClientRect()

      const fingerPositionX = touch.clientX - rect.left
      const fingerPositionY = rect.height - (touch.clientY - rect.top)

      const fingerOriginDistance = sqrt(
        pow(fingerPositionX - joystick.origin.x, 2) + pow(fingerPositionY - joystick.origin.y, 2),
      )

      joystick.origin.angle =
        (atan2(fingerPositionY - joystick.origin.y, fingerPositionX - joystick.origin.x) + 2 * pi) %
        (2 * pi)

      const currentX =
        mode === 'origin'
          ? joystick.origin.x +
            Math.min(fingerOriginDistance, maxOriginDistance) * cos(joystick.origin.angle)
          : touch.clientX - rect.left
      const currentY =
        mode === 'origin'
          ? joystick.origin.y +
            Math.min(fingerOriginDistance, maxOriginDistance) * sin(joystick.origin.angle)
          : rect.height - (touch.clientY - rect.top)

      joystick.movement.x = currentX - joystick.current.x
      joystick.movement.y = currentY - joystick.current.y
      joystick.current.x = currentX
      joystick.current.y = currentY

      joystick.origin.distance = sqrt(
        pow(currentX - joystick.origin.x, 2) + pow(currentY - joystick.origin.y, 2),
      )

      if (mode === 'origin') {
        if (joystick.origin.distance > maxOriginDistance - 0.01) {
          joystick.origin.distance = maxOriginDistance
        }
      }

      joystick.origin.distanceRatio = maxOriginDistance
        ? joystick.origin.distance / maxOriginDistance
        : 1
      if (joystick.origin.distanceRatio > 0.99) {
        joystick.origin.distanceRatio = 1
      }

      if (mode === 'follow') {
        if (joystick.follow.x !== null && joystick.follow.y !== null) {
          joystick.follow.angle =
            (atan2(fingerPositionY - joystick.follow.y, fingerPositionX - joystick.follow.x) +
              2 * pi) %
            (2 * pi)

          joystick.follow.distance = sqrt(
            pow(currentX - joystick.follow.x, 2) + pow(currentY - joystick.follow.y, 2),
          )
          if (joystick.follow.distance > maxFollowDistance - 0.01) {
            joystick.follow.distance = maxFollowDistance
          }

          joystick.follow.distanceRatio = maxFollowDistance
            ? joystick.follow.distance / maxFollowDistance
            : 1

          joystick.follow.angle =
            (atan2(currentY - joystick.follow.y, currentX - joystick.follow.x) + 2 * pi) % (2 * pi)

          if (joystick.follow.distance >= maxFollowDistance) {
            const oppositeFollowAngle = Math.atan2(
              joystick.follow.y - currentY,
              joystick.follow.x - currentX,
            )
            joystick.follow.x = currentX + maxFollowDistance * cos(oppositeFollowAngle)
            joystick.follow.y = currentY + maxFollowDistance * sin(oppositeFollowAngle)
          }
        }
      }

      joystick.origin.angle =
        (atan2(currentY - joystick.origin.y, currentX - joystick.origin.x) + 2 * pi) % (2 * pi)

      onMove?.(joystick)

      if (resetMovementTimeout !== null) {
        clearTimeout(resetMovementTimeout)
      }

      const movementSession = session
      resetMovementTimeout = setTimeout(() => {
        resetMovementTimeout = null

        // Only flush the movement reset for the session that scheduled it.
        // A newer session or unmount invalidates this callback, and a `null`
        // identifier means the joystick was already fully reset.
        if (disposed || movementSession !== session || joystick.identifier === null) {
          return
        }

        joystick.movement.x = 0
        joystick.movement.y = 0

        onMove?.(joystick)
      }, 70)
    }
  }

  const handleTouchEnd = (e: TouchEvent) => {
    e.preventDefault()

    if (disposed || !joystick) {
      return
    }

    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = getTouchAt(e.changedTouches, i)

      if (!touch || joystick.identifier !== touch.identifier) {
        continue
      }

      joystick.movement.x = 0
      joystick.movement.y = 0

      // Movement is already zeroed above, so cancel its debounced reset to
      // avoid a stale extra onMove after release.
      if (resetMovementTimeout !== null) {
        clearTimeout(resetMovementTimeout)
        resetMovementTimeout = null
      }

      onEnd?.(joystick)

      if (endResetTimeout !== null) {
        clearTimeout(endResetTimeout)
      }

      const endSession = session
      endResetTimeout = setTimeout(() => {
        endResetTimeout = null

        // A new touch session started during the reset delay, or the area was
        // unmounted: never reset the current joystick state here.
        if (disposed || endSession !== session) {
          return
        }

        resetJoystick()
        onEnd?.(joystick)
      }, 50)
    }
  }

  // Binding events by ref instead of JSX attributes to make them active instead of passive
  // and have access to e.preventDefault(). Without e.preventDefault(), the UI is no longer
  // interactable while joysticks are moving due to touchmove.
  element.addEventListener('touchstart', handleTouchStart /*, { passive: false } */)
  element.addEventListener('touchmove', handleTouchMove /*, { passive: false } */)
  element.addEventListener('touchend', handleTouchEnd /*, { passive: false } */)

  return () => {
    // Idempotent: React (or a double invoke) must not remove listeners twice.
    if (disposed) {
      return
    }

    disposed = true
    // Invalidate every timer captured by the previous session.
    session += 1

    if (resetMovementTimeout !== null) {
      clearTimeout(resetMovementTimeout)
      resetMovementTimeout = null
    }
    if (endResetTimeout !== null) {
      clearTimeout(endResetTimeout)
      endResetTimeout = null
    }

    element.removeEventListener('touchstart', handleTouchStart)
    element.removeEventListener('touchmove', handleTouchMove)
    element.removeEventListener('touchend', handleTouchEnd)

    // Return the joystick to the same initial state as `createJoystick` so an
    // identifier or coordinates from the removed element never linger. This
    // reset is silent: neither onMove nor onEnd is emitted.
    resetJoystick()
  }
}
