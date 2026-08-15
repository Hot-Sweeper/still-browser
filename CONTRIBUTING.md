# Contributing

Thanks for improving Still.

## Local workflow

1. Install Node.js 22.12 or newer.
2. Run `npm ci`.
3. Run `npm start` while developing.
4. Run `npm run check` before opening a pull request.
5. Run `npm run pack` when changing packaging or platform integration.

Keep changes focused and describe the user-visible behavior in the pull request. Test on the operating systems affected by the change. Windows native mouse-helper changes additionally require the .NET 8 SDK.

Do not commit generated packages, downloaded tools, browser profiles, cookies, diagnostic logs, or other personal browsing data. The repository ignore rules cover the standard generated locations.
