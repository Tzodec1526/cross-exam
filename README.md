# Cross Examination

Practice a cross-examination, a deposition, or a hearing on your own computer. You ask the questions. A witness, a party, or a judge answers from the documents you import.

Keep the files local. The case file, the search index, the transcript, and the report stay on this computer, and live audio and the report text go to xAI. The app does not upload documents to xAI Collections. Use an xAI account with Zero Data Retention for a real client file.

Speech uses `grok-voice-think-fast-2.0`. Reports use `grok-4.7`. The app does not follow the floating `grok-voice-latest` alias.

## Download (Windows)

1. Download [CrossExamination-win-x64.zip](https://github.com/Tzodec1526/cross-exam/releases/latest/download/CrossExamination-win-x64.zip).
2. Unzip it.
3. Run `CrossExamination.exe`.

The zip is unsigned. If you trust this source, choose More info, then Run anyway, because Windows may say the publisher is unknown.

## Run from source

Install Node `24.18.0` and npm `11.16.0`.

```bash
npm ci
npm run electron:dev
```

## Load a case

1. Create a matter.
2. Import [sample-deposition.txt](https://github.com/Tzodec1526/cross-exam/releases/latest/download/sample-deposition.txt), or your own PDF, DOCX, TXT, or MD files. A source checkout also has `fixtures/sample-deposition.txt`.
3. Reindex.
4. Add a person.
5. Import an xAI API key in Settings, or start the app with `$env:XAI_API_KEY="xai-..."`.
6. Begin the exam.

A second launch focuses the window that is already open. It does not open a second copy of your files.

Dev builds keep `matters/` and `data/` in this folder. Git ignores both. A packaged build keeps them in Electron's user-data directory.

## Build

Run the full check. `npm run check` typechecks, runs the tests, and builds, and `npm run package:qa` writes an unsigned Windows folder to `release/win-unpacked` for a local test. It is not a signed installer.

The advocacy method is in [docs/advocacy-method.md](docs/advocacy-method.md), interface rules are in [docs/frontend-design.md](docs/frontend-design.md), and the signed-release runbook is in [docs/release-runbook.md](docs/release-runbook.md). MIT License. See [LICENSE](LICENSE).
