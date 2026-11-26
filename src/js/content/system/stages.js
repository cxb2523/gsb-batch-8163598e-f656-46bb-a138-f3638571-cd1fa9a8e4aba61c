content.system.stages = (() => {
  let ceiling,
    floor,
    mix = 0

  return {
    ceiling: () => (ceiling && !ceiling.destroyed) ? ceiling : null,
    floor: () => (floor && !floor.destroyed) ? floor : null,
    reset: function () {
      // Stages may already have been destroyed by a global prop reset, so
      // destroy() must be idempotent.
      if (ceiling) {
        ceiling.destroy()
      }

      if (floor) {
        floor.destroy()
      }

      ceiling = null
      floor = null
      mix = 0

      return this
    },
    update: function () {
      const t = content.system.time.get(),
        ti = Math.floor(t)

      const ceilingT = ti + 1,
        floorT = ti

      // Reuse the stages already sitting on the target boundaries and retire the
      // rest. Large jumps therefore create at most two stages rather than one
      // for every skipped second, and a stage is only ever generated once.
      const previous = [floor, ceiling].filter((stage, index, stages) => stage && !stage.destroyed && stages.indexOf(stage) === index)

      floor = null
      ceiling = null

      for (const stage of previous) {
        if (!floor && stage.t === floorT) {
          floor = stage
        } else if (!ceiling && stage.t === ceilingT) {
          ceiling = stage
        } else {
          stage.destroy()
        }
      }

      if (!floor) {
        floor = content.system.stages.stage.create(floorT)
      }

      if (!ceiling) {
        ceiling = content.system.stages.stage.create(ceilingT)
      }

      mix = engine.utility.scale(t, floorT, ceilingT, 0, 1)

      ceiling.setMix(mix)
      floor.setMix(1 - mix)

      return this
    },
  }
})()

engine.loop.on('frame', ({paused}) => {
  if (paused) {
    return
  }

  content.system.stages.update()
})

engine.state.on('reset', () => content.system.stages.reset())
