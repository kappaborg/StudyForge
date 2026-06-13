/* eslint-disable */
/**
 * Minimal Jest config for the API service. Picks up any ``*.spec.ts``
 * file under ``src/`` with the standard ts-jest transform. Mirrors the
 * Nest CLI default; we only ship this file so tests run via ``pnpm
 * --filter api test`` without each contributor having to set it up.
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }],
  },
  testEnvironment: 'node',
  moduleNameMapper: {
    // ESM-style ``.js`` import suffix that Node resolves but ts-jest
    // doesn't follow by default — keep the path resolution sane.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
