import { useEffect, useRef } from 'react'

import { mountJoystickArea } from '@manapotion/core'

import type { JoystickAreaProps } from '@manapotion/core'
import type { DetailedHTMLProps, HTMLAttributes, PropsWithChildren, RefObject } from 'react'

// react-merge-refs v2.1.1
function mergeRefs<T = unknown>(
  refs: Array<React.MutableRefObject<T> | React.LegacyRef<T> | undefined | null>,
): React.RefCallback<T> {
  return value => {
    refs.forEach(ref => {
      if (typeof ref === 'function') {
        ref(value)
      } else if (ref != null) {
        ;(ref as React.MutableRefObject<T | null>).current = value
      }
    })
  }
}

type JoystickAreaBaseProps = PropsWithChildren<
  Omit<JoystickAreaProps, 'element'> & {
    containerProps: DetailedHTMLProps<HTMLAttributes<HTMLDivElement>, HTMLDivElement>
    ref?: RefObject<HTMLDivElement | null>
  }
>

export const JoystickArea = ({
  mode,
  joystick,
  maxFollowDistance,
  maxOriginDistance,
  onEnd,
  onMove,
  onStart,
  containerProps,
  children,
  ref,
}: JoystickAreaBaseProps) => {
  const localRef = useRef<HTMLDivElement>(null)
  const mergedRefs = mergeRefs([localRef, ref])

  // Always invoke the latest callbacks without re-running the binding effect.
  // Callbacks are commonly passed as fresh inline functions on every render,
  // so depending on them directly would remove/re-add the touch listeners and
  // reset an in-progress joystick session on unrelated parent re-renders.
  const callbacksRef = useRef({ onStart, onMove, onEnd })
  callbacksRef.current = { onStart, onMove, onEnd }

  useEffect(() => {
    const element = localRef.current

    if (!element) {
      return
    }

    const cleanup = mountJoystickArea({
      mode,
      joystick,
      maxFollowDistance,
      maxOriginDistance,
      element,
      onStart: joystick => callbacksRef.current.onStart?.(joystick),
      onMove: joystick => callbacksRef.current.onMove?.(joystick),
      onEnd: joystick => callbacksRef.current.onEnd?.(joystick),
    })

    // Returning the cleanup guarantees listeners and pending reset timers are
    // disposed on unmount and before every re-run of these structural deps.
    return cleanup
  }, [mode, joystick, maxFollowDistance, maxOriginDistance])

  return (
    <div ref={mergedRefs} {...containerProps}>
      {children}
    </div>
  )
}
