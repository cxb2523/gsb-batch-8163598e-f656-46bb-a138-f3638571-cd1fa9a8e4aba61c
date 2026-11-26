content.system.stages.stage = {}

content.system.stages.stage.create = function (...args) {
  return Object.create(this.prototype).construct(...args)
}

content.system.stages.stage.prototype = {
  construct: function (t) {
    this.destroyed = false
    this.t = t
    this.props = null

    this.bus = content.system.kaleido.createSend()
    this.bus.gain.value = engine.const.zeroGain
    this.gain = engine.const.zeroGain

    this.generate()

    return this
  },
  destroy: function () {
    // Stages can be referenced after they've been replaced, so destruction
    // must be safe to call any number of times.
    if (this.destroyed) {
      return this
    }

    this.destroyed = true

    const props = this.props || []
    this.props = []
    this.gain = engine.const.zeroGain

    // A global state reset may have already destroyed the props before us,
    // in which case destroying them again would stop their synths twice.
    const live = typeof engine.props.get == 'function'
      ? new Set(engine.props.get())
      : null

    engine.props.destroy(...(
      live
        ? props.filter((prop) => live.has(prop))
        : props
    ))

    // Release the bus only after its contribution has faded out, and only once.
    const bus = this.bus
    this.bus = null

    if (bus) {
      const fadeOutDuration = (content.prop.tone && content.prop.tone.fadeOutDuration) || 0,
        lookahead = engine.const.audioLookaheadTime || 0

      engine.audio.ramp.linear(bus.gain, engine.const.zeroGain, fadeOutDuration)

      setTimeout(() => bus.disconnect(), (fadeOutDuration + lookahead) * 1000)
    }

    return this
  },
  generate: function () {
    if (this.destroyed || this.props) {
      return this
    }

    const frequencies = content.system.frequencies.get(this.t)

    this.props = []

    for (let i = 0; i < content.const.stagePropCount; i += 1) {
      this.props.push(
        this.generateProp(i, frequencies)
      )
    }

    return this
  },
  generateProp: function (index, frequencies) {
    const srand = engine.utility.srand('stage', this.t, 'prop', index)

    const angle = srand(0, Math.PI * 2),
      distance = srand(content.const.stageMinRadius, content.const.stageMaxRadius)

    return engine.props.create(content.prop.tone, {
      destination: this.bus,
      detune: srand(0),
      frequency: engine.utility.choose(frequencies, srand()),
      modFrequency: srand(),
      radius: 0,
      x: Math.cos(angle) * distance,
      y: Math.sin(angle) * distance,
    })
  },
  setMix: function (gain) {
    if (this.destroyed || !this.bus) {
      return this
    }

    this.gain = gain
    engine.audio.ramp.linear(this.bus.gain, gain, engine.loop.delta())
    return this
  },
}
