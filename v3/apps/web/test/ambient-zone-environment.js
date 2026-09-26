/**
 * jsdom, plus a way for a spec to move the process's own timezone (#321).
 *
 * A spec opts in with the docblock `@jest-environment ./test/ambient-zone-environment.js`
 * and then calls `withAmbientZone(zone)` from `./ambient-zone`.
 *
 * Why an environment and not `process.env.TZ = ...` in the spec: jest hands
 * test code its own copy of `process.env`, so an assignment there never
 * reaches Node, and every date keeps reading the host's zone -- which on this
 * project's machines is already Asia/Tehran, the one zone in which a
 * wall-clock bug of this kind cannot be seen. This file runs outside that
 * sandbox, holds the real `process`, and puts the original zone back when the
 * spec file is done, so no later spec in the same worker inherits it. Node
 * re-reads `TZ` when it is assigned; deleting it does not, so the zone is
 * restored by name.
 */
const { TestEnvironment } = require('jest-environment-jsdom');

class AmbientZoneEnvironment extends TestEnvironment {
  constructor(config, context) {
    super(config, context);
    this.originalZone = process.env.TZ;
    this.resolvedZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.global.__setAmbientZone = (zone) => {
      process.env.TZ = zone ?? this.originalZone ?? this.resolvedZone;
    };
  }

  async teardown() {
    process.env.TZ = this.originalZone ?? this.resolvedZone;
    await super.teardown();
  }
}

module.exports = AmbientZoneEnvironment;
