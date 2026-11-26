// The app's imports are extensionless, which a bundler resolves and plain Node ESM does
// not. Append .ts for relative specifiers so the real source files run unchanged.
export async function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    try {
      return await next(`${specifier}.ts`, context);
    } catch {
      // Fall through to the default resolver for directory and .js specifiers.
    }
  }
  return next(specifier, context);
}
