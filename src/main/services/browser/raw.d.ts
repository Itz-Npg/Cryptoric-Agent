/**
 * Vite inlines `?raw` imports as strings at build time. The page bridge is
 * loaded this way so it stays a real, lintable `.js` file instead of an
 * unreadable template literal inside a `.ts` module.
 */
declare module '*.js?raw' {
  const content: string
  export default content
}