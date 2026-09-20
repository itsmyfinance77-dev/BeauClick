/*
 * CSS imports carry no behaviour into jsdom, but CSS MODULES carry names.
 *
 * `import styles from './x.module.css'` then `className={styles.tabBar}` has
 * to produce a string, or every element styled by a module renders
 * `class="undefined"` and a test that asserts on structure is asserting on
 * nothing. jsdom still computes no styles -- this only preserves the class
 * names -- so a layout claim needs a real browser either way.
 *
 * The identity proxy returns the key for any property, which is what
 * `identity-obj-proxy` does, written here rather than added as a dependency.
 */
module.exports = new Proxy(
  {},
  {
    get(_target, key) {
      // Let the interop layer see this as a CommonJS module, so the default
      // import receives the proxy itself rather than `undefined`.
      if (key === '__esModule') return false;
      if (typeof key !== 'string') return undefined;
      return key;
    },
  },
);
