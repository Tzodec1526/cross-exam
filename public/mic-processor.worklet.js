class MicProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel && channel.length) {
      const copy = new Float32Array(channel.length);
      copy.set(channel);
      this.port.postMessage({ samples: copy }, [copy.buffer]);
    }
    return true;
  }
}

registerProcessor("mic-processor", MicProcessor);
