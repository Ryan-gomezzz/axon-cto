import { describe, it, expect } from 'vitest';
import { PACKAGE_NAME } from '../src/index.js';

describe('@axon/sprint smoke', () => {
  it('exports the package name', () => {
    expect(PACKAGE_NAME).toBe('@axon/sprint');
  });
});
