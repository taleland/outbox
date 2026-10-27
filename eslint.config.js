import neostandard from 'neostandard';

export default [
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  ...neostandard({ noJsx: true, semi: true, ts: true }),
];
