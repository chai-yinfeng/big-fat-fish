import { observationFromOneBot } from './source.js';

/** Feed authenticated OneBot envelopes into the shared conversation port.
 * Transport authentication/login and operator identity bindings remain outside.
 */
export class QQIngress {
  #port; #expectedSelfId;
  constructor({ port, expectedSelfId }) {
    this.#port = port;
    this.#expectedSelfId = expectedSelfId;
  }
  observe(event) {
    const observation = observationFromOneBot(event, { expectedSelfId: this.#expectedSelfId });
    return observation ? this.#port.observe(observation) : null;
  }
}
