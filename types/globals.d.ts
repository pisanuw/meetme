/**
 * Ambient declarations for runtime globals that exist on the Netlify Functions
 * platform but are not part of the standard Node typings. This lets
 * `tsc --checkJs` verify the source without rewriting it to TypeScript.
 *
 * `Netlify.env.get` is the v2 Functions runtime accessor used by lib/env.mjs.
 * See: https://docs.netlify.com/functions/api/#netlify-global-object
 */
declare global {
  const Netlify:
    | {
        env: {
          get(name: string): string | undefined;
          has?(name: string): boolean;
          set?(name: string, value: string): void;
        };
      }
    | undefined;
}

export {};
