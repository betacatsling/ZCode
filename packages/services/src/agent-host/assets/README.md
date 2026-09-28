# AgentHost static Harness assets

The `pi-light` and `pi-dark` assets in `../harnessAssets.ts` are a small SVG rendering of the four-by-four mark and fixed colors documented by Pi's official logo implementation. Source: `earendil-works/pi` tag `v0.87.1`, commit `f07218c4d4bbc12bef056a7058c3dd49dfe41abe`, file `packages/coding-agent/src/modes/interactive/components/pi-logo.ts`. The source repository's MIT notice is Copyright (c) 2025 Mario Zechner; the full permission notice is recorded below and at the [tagged license](https://github.com/earendil-works/pi/blob/v0.87.1/LICENSE).

The `zcode-light` and `zcode-dark` assets are inline vector renderings of the ZCode application mark in `packages/desktop/build/icon.png`. They use no model-provider artwork.

The Host registry serves only these four IDs as `image/svg+xml`; the IDs are not converted to paths or URLs. The SVG contract limits markup to inline geometry and rejects scripts, event attributes, declarations, and external references.

## Pi asset license notice

MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
