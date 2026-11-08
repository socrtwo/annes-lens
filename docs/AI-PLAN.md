# AI plan

> **Status (M7).** The AI tab is built: `src/ai/` holds the service adapters (OpenAI-compatible, Anthropic, Gemini), the on-device runtime (ONNX Runtime Web) with its model registry, the ensemble, history and provenance; `src/commands/ai*.ts` the commands. Where this document and the code differ, the differences are listed under *What is built* at the end. The rest of this document is the plan it was built from.

> **Plan.** This document fixes what the **AI** tab and the **AI** menu (present in every classic menu layout) will do, which services and on-device models they use, and the rules for privacy, cost and provenance. Command ids are in [COMMANDS-PLAN.md](COMMANDS-PLAN.md#ai).

The AI tab is optional. Nothing is sent anywhere until you run an AI command, and every AI command is an ordinary command: it can go on the Quick Access Bar, on a custom tab, in any menu layout, on a shortcut, or in a macro or batch recipe.

## What the AI tab does

| Group | Commands | Runs on |
|---|---|---|
| **Generate** | Generate Picture, Variations, Sketch to Picture, Generate with References, Generate Background, Generate Vector, Seamless Pattern, Picture to Prompt, Compare Providers, Prompt Library | a picture service you set up (local or hosted); Picture to Prompt also on a text/vision model |
| **Edit** | Edit by Instruction, Generative Fill, Erase Object, Expand Picture, Replace Object, Remove/Replace/Blur Background, Relight, Recolor Object, Restyle, Upscale, Unblur, AI Noise Reduction, Colorize, Repair Damage, Remove Glare, Translate Text in Picture, Combine Group Shots, Smart Crop | on the device where a small model does the job well (erase, background, upscale, denoise, smart crop); otherwise a picture service |
| **Select** | Select Subject, Select by Description, Depth Map | on the device |
| **Understand** | Describe, Alt Text, Ask About This Picture, Suggest Keywords, Write Caption, Transcribe Handwriting, Identify, Estimate Date, Culling Assistant, Search by Content, Find Similar by Content, Run on Selection | a vision-capable text model (on device, local or hosted); search and similarity on the device |
| **Provenance** | Content Credentials on AI Results, AI History | the app |
| **Providers** | Set Up AI, Providers and Models, Active AI, AI and Privacy, Several AIs, Choose AIs, Show AI Discussion, Stop AI, Delete Downloaded Models | the app |

### How an edit is applied

- Every AI result that changes a picture arrives as **one undoable step** and, by default, as a **new version** beside the original (`photo.jpg` → `photo (AI edit 1).jpg`, stacked with it in Browse), never over the original unless you choose *Replace original* in the result bar.
- Selection-based commands (Generative Fill, Erase Object, Replace Object, Recolor) send the picture and a mask built from the current selection; the result is blended back only inside the feathered mask, so pixels outside it are untouched — the app checks this and warns if a service changed pixels outside the mask.
- Commands that a provider cannot do natively are composed from others where the result is reliable (for example, Expand Picture on a service that only supports masked fill becomes canvas size + fill); otherwise the command is disabled for that provider with a tooltip that says why.
- Generated pictures open as new, unsaved pictures with the prompt, provider, model, seed and date in their metadata and in **AI History**.
- **Compare Providers** (`ai.generateCompare`) sends one prompt or edit to two to six picture services at once and lays the results out as a contact sheet with each service's name, time and stated cost; you keep one, several or none. This is the picture counterpart of the suite's several-AI modes ([ENSEMBLE.md](ENSEMBLE.md)), which apply to the text commands.

## Setting up

**AI ▸ Set Up AI** is the suite's wizard with one addition: it asks separately for a **text and vision service** (for Describe, Alt Text, Ask, Transcribe, Identify, Keywords and Captions) and a **picture service** (for Generate and the generative Edit commands). One account may serve both. The wizard

1. lists services grouped as *Free · on device*, *Free · your computer*, *Free tier*, *Free trial* and *Paid*;
2. links to the service's key page and checks the key with a test request (a tiny, cheap request; never a full-size generation);
3. fetches the service's model list where the service publishes one, so you choose models by name rather than from a list frozen into the app;
4. shows what each command will send and, for paid services, the price the service publishes per picture or per token, with a link to the current price page.

Service terms, free tiers and model names change often; the wizard links to each service's current pages instead of promising limits or prices.

### Picture services (planned adapters)

| Group | Services |
|---|---|
| Your computer | ComfyUI (workflow templates for text-to-image, image-to-image, inpaint, outpaint, upscale), AUTOMATIC1111/Forge-compatible and SD.Next APIs, InvokeAI, any OpenAI-compatible local images endpoint |
| Hosted, first party | OpenAI Images (generation and edits with masks), Google Gemini and Imagen (generation and conversational editing), Black Forest Labs (FLUX generation and instruction editing), Stability AI (generation plus erase, inpaint, outpaint, search-and-replace, search-and-recolor, remove background, upscale endpoints), Ideogram (text-heavy pictures), Recraft (vector and icon output), xAI image generation, Amazon Bedrock picture models, Alibaba Qwen image models |
| Hosted, aggregators | Hugging Face Inference Providers, Replicate, fal, Together, OpenRouter (picture-capable models), Cloudflare Workers AI |
| Custom | any service with an OpenAI-compatible images API, or a ComfyUI workflow you export (the app maps its inputs: prompt, picture, mask, seed, size) |

Services with no public API (some consumer apps) are not supported. Each adapter declares its **capabilities** (generate, edit with mask, edit by instruction, expand, references, vector output, transparent output, sizes, count, seed, negative prompt, safety level settings), and the app enables commands from that list.

### Text and vision services

The same list as the sister apps ([Anne's Grid AI](https://github.com/socrtwo/QuillGrid/blob/main/docs/AI.md)): Ollama and LM Studio on your computer; free tiers (OpenRouter free models, Google Gemini, Groq, Mistral, Cerebras, SambaNova, Cohere, NVIDIA NIM, Cloudflare Workers AI and others); paid keys (OpenAI, Anthropic, DeepSeek, xAI, Perplexity, Together, Fireworks, Hugging Face, Moonshot, Alibaba Qwen, Azure, Amazon Bedrock, any OpenAI-compatible service). Only vision-capable models are offered for commands that send a picture.

## On the device

Anne's Lens runs small models with ONNX Runtime Web or Transformers.js in a worker, on WebGPU when available and WebAssembly otherwise; the desktop app can also use the GPU through the same runtime. Each model is downloaded once, on first use, after showing its size and license, and then works offline. **Delete Downloaded Models** frees the space.

| Job | Commands | Candidate models (license to be confirmed at implementation; only permissive licenses accepted) |
|---|---|---|
| Inpainting / object removal | Erase Object, Repair Damage (small areas) | LaMa-family inpainting (Apache 2.0) |
| Background matting and segmentation | Remove/Replace/Blur Background, Select Subject | MODNet (Apache 2.0), BiRefNet (MIT); segment-anything-family models under Apache 2.0 for click and box prompts |
| Depth | Blur Background, Depth Map, Relight (approximate) | Depth Anything V2 Small (Apache 2.0) |
| Super-resolution | Upscale | Real-ESRGAN-family (BSD-3-Clause) |
| Denoise / deblur | AI Noise Reduction, Unblur | NAFNet-family (MIT) |
| Colorization | Colorize | DDColor (Apache 2.0) |
| OCR | Recognize Text (Tools), Translate Text in Picture | Tesseract via tesseract.js (Apache 2.0) |
| Embeddings for search | Search by Content, Find Similar by Content, Suggest Keywords | SigLIP/CLIP-family image–text encoders under Apache 2.0 or MIT |
| Captions and questions | Describe, Alt Text, Ask (short answers) | small vision-language models (for example Florence-2, MIT) |
| Faces | People view, Combine Group Shots (alignment), Culling Assistant (eyes open) | face detection and landmark models under permissive licenses; **off until the user turns People on**, and face data never leaves the device |

Models that are free only for non-commercial use (several popular background-removal and face-restoration models) are not bundled or offered for download, because the project is MIT-licensed and must stay usable by anyone. A user can still point the app at such a model on their own computer through ComfyUI or a local server.

Generating pictures from text on a phone is slow and memory-hungry even with small distilled models; the plan offers on-device generation only on desktop builds with WebGPU, as an optional download, and recommends a local server or hosted service otherwise. This is stated in the wizard rather than discovered by a failed run.

## Search by content

When the catalog is on, Anne's Lens can build an on-device embedding index of your pictures (opt-in, per folder, with a progress bar and pause). **Search by Content** then finds pictures from a description ("snow on the porch", "Dad's 1957 Chevrolet"), and **Find Similar by Content** finds pictures that mean the same thing even when they look different. The index is stored in the catalog; it is never uploaded. OCR text and captions join the same index, so a search for a surname finds scanned letters and captioned photos together.

## Provenance and labeling

- **Content Credentials on AI Results** (`ai.contentCredentials`, on by default) writes a C2PA manifest and the IPTC *Digital Source Type* (`trainedAlgorithmicMedia` for generated pictures, `compositeWithTrainedAlgorithmicMedia` for pictures with AI edits) into AI results, plus an `AI edit` entry in the XMP history listing the command, service and model. Where a service returns its own credentials or watermark, Anne's Lens keeps them.
- **Metadata ▸ Content Credentials** (`meta.provenance`) reads these marks in any picture, shows them in the Info pane, and warns when a picture's history says it was AI-made but the marks were removed by a later edit.
- **Privacy Check** and **Strip Metadata** never remove AI provenance silently: stripping it requires ticking a separate box that says what it is.
- Anne's Lens does not offer an "AI detector". Detectors that guess from pixels are unreliable; the app reports what a file *says* about itself and lets you check a picture's credentials, not a verdict.
- **Colorize**, **Repair Damage** and **Estimate Date** are presented as interpretations: colorized and repaired versions are saved as new versions with *AI-colorized* or *AI-restored* in the title field, and date estimates are written only to a separate, clearly named field, never to *Date Taken*. This matters for family-history and archival work, where a plausible guess must not be mistaken for a record.

## What the app will not do

The picture services enforce their own usage policies, and Anne's Lens adds a few rules of its own, stated in the AI tab's help and enforced in the commands:

- No commands to remove watermarks, logos or copyright notices from other people's pictures. Erase Object is a general tool; its help says it is for your own pictures and those you have rights to edit.
- No sexualized or nude edits of real people, and no "undress", "age down" or body-reshaping commands. Requests a service refuses are shown as refused, without retry tricks.
- No face swapping between different people. **Combine Group Shots** only replaces a person's face with the *same person's* face from another frame of the same burst, and asks you to confirm each replacement.
- Edits to recognizable people in pictures you plan to share carry a reminder, once per session, that AI-edited pictures of real people should be labeled; the provenance marks above do the labeling.

## Privacy and keys

- Keys are stored in the platform's secure storage (Android Keystore, iOS Keychain, the desktop OS credential store; the web build encrypts them with a passphrase you choose), never in settings exports, macros or AI History.
- Before the first use of each command with each service, a dialog shows what will be sent (the picture at what size, the mask, the prompt, any metadata) and to whom. Location and other metadata are **stripped from every picture sent to a service** unless the command needs them; the dialog says so.
- **AI and Privacy** lists, per command, what is sent, and lets you require on-device processing only (commands that cannot run on the device are then disabled).
- **AI History** keeps the prompt, service, model, settings, time, stated cost and a thumbnail of the result, on the device; it can be cleared or turned off.
- **Run on Selection** (`ai.batch`) shows an estimated number of requests and, where the service publishes prices, an estimated cost before starting, and stops at a cap you set.


## What is built (M7)

- **Providers.** Set Up AI edits one service at a time: a preset (Ollama, LM Studio or any OpenAI-compatible server on your computer; OpenRouter, Google Gemini, Groq, Mistral, OpenAI, Anthropic, Together hosted), the address, the key, a text-and-vision model and an optional picture model, with *Fetch model list* (the service's own list) and *Test* (one tiny chat request). Active AI chooses the text service and the picture service separately, device-first or service-first, and whether edited results open as a new picture or replace the current one. Providers and Models lists services and on-device models with their download state.
- **Transport.** The desktop app sends requests from its main process and the Android app through `HttpURLConnection`, so services without CORS headers work; the web build uses `fetch()` (OpenAI, OpenRouter, Groq, Gemini and Anthropic allow it; Ollama needs `OLLAMA_ORIGINS`).
- **On-device runtime.** ONNX Runtime Web is loaded at run time from the app's own copy when the build put one there (`QN_ORT_LOCAL=1`, which the desktop build sets, writes `runtimes.json`; the desktop's Content Security Policy only allows the app's own scripts) and otherwise from the jsDelivr CDN; models come from the Hugging Face Hub on first use (a dialog states the size and license) into the browser cache, and Delete Downloaded Models clears it. WebGPU is used when the browser has a usable adapter, WebAssembly otherwise. Models: `Xenova/modnet` (matting), `onnx-community/depth-anything-v2-small`, `Carve/LaMa-ONNX` (inpainting, 512-px tile around the selection), `Xenova/swin2SR-classical-sr-x2-64` and `Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr` (super-resolution in 288-px tiles; Unblur and AI Noise Reduction restore at ×4 and resample back), `Xenova/clip-vit-base-patch32` (text and picture embeddings with the CLIP BPE tokenizer in `src/ai/clipTokenizer.ts`). Quantized files by default; full precision is a setting.
- **Keys.** Stored in the platform's secure storage: the desktop through Electron's safeStorage (the OS credential store; a Linux desktop without a keyring falls back to its lightly protected file, and the dialogs say so), Android in EncryptedSharedPreferences backed by the Keystore, the web app and the iOS app (which runs the web code) encrypted with a passphrase chosen by the user (PBKDF2, 600 000 rounds, AES-GCM) and asked for once per session, or unencrypted in the browser's storage when the user declines. Keys saved in the settings by earlier versions move to the store on the first start. Settings exports, macros and AI History never contain keys; AI and Privacy shows where the keys are, sets or changes the passphrase, and forgets every stored key.
- **Content Credentials.** AI results carry the IPTC digital source type and the app's provenance fields (command, service, model, prompt, date) in XMP, and when saved as JPEG or PNG a C2PA manifest (CBOR assertions `c2pa.actions` with the action, source type, software agent, service, model and prompt, and `c2pa.hash.data` over the file; a claim; a COSE_Sign1 ES256 signature with the certificate in its header), written by the app's own code from the C2PA specification into APP11 segments, a `caBX` chunk or a WebP `C2PA` chunk. An AI edit saved this way also carries its ingredient: the picture it started from, with a small JPEG thumbnail, a `c2pa.opened` action pointing at it, and that picture's own manifests copied into the store when it had any, so a chain of edits keeps every signature. The signer is an ECDSA P-256 key with a self-signed certificate made on the device and kept in the keystore: validators (c2patool, the Content Credentials site) show the hashes and signature as valid and the signer as not on their trust list, which is the truth about a certificate nobody vouches for. The app reads manifests back, checks the hashes and the signature, and shows the result in the details. Pictures without AI provenance get no manifest.
- **On-device generation.** Set Up AI's "This device" picture service runs Generate Picture through Transformers.js (loaded on demand from the build's own copy or the pinned CDN) with DeepSeek's Janus-Pro-1B in ONNX form: about 2 GB downloaded once into the browser cache, WebGPU when the browser has it (the desktop app, Chrome, Edge) and WebAssembly otherwise with a warning, 384 × 384 pictures from a prompt only; edits, masks, sizes, seeds and negative prompts stay with the picture services. The model's weights are not under a permissive license (MIT code, weights under the DeepSeek Model License with use restrictions), so the model is never bundled or fetched on its own: the user chooses the service and accepts the license in the download dialog, which names it as it is. No permissively licensed text-to-image model of a size a browser can run exists yet; when one does, it replaces the default.
- **Differences from the plan.** An iOS Keychain plugin is still to do (iOS uses the passphrase store); a certificate from a trusted authority is not provided (it would need an identity and a contract); Colorize, Remove Glare and Reflections, Restyle and Repair Damage without a selection go through the picture service (no on-device model yet); Generate Vector traces a flat-style generated picture on the device (no service returns vectors yet); on-device generation uses a model whose weights carry use restrictions (above), accepted by the user, rather than a permissive one; Search by Content indexes the open folder in memory (no catalog yet); Several AIs applies to the Understand commands (Describe, Alt Text, Ask, Keywords, Caption, Transcribe, Identify, Estimate Date, Picture to Prompt, Select by Description, Translate).
- **Tests.** Unit tests cover the adapters' request and answer shapes, the tokenizer, every on-device job against a fake session, the ensemble, history and preference sanitizing. The e2e smoke test runs the commands against a mock OpenAI-compatible server and the real ONNX runtime with tiny fixture models shaped like the real ones (`tests/fixtures/ai/`, made by `scripts/gen-ai-fixtures.py`).
