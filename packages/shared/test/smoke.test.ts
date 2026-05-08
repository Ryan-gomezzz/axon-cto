import { describe, it, expect } from 'vitest';
import { PACKAGE_NAME } from '../src/meta.js';

describe('@axon/shared smoke', () => {
  it('exports the package name', () => {
    expect(PACKAGE_NAME).toBe('@axon/shared');
  });
});
