import '@testing-library/jest-dom';

// jsdom has no layout engine and does not implement `scrollIntoView` at all,
// so a component that calls it (AdminShell, scrolling the current nav item
// into view) throws `TypeError: ... is not a function` inside an effect,
// which React surfaces as a render failure across every test that mounts it.
// A no-op stub is standard practice for this exact gap.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
