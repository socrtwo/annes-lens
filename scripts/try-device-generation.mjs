#!/usr/bin/env node
/**
 * Runs the on-device picture generator the app offers (Janus-Pro-1B through Transformers.js) once, in Node, to
 * check the pipeline end to end: downloads the model (about 2 GB on first run, cached by Transformers.js), makes one
 * 384 × 384 picture from a prompt and writes it as PNG. Slow on a CPU (minutes). Usage:
 *   node scripts/try-device-generation.mjs "a red bicycle on a beach" out.png
 */
import { AutoProcessor, MultiModalityCausalLM, env } from '@huggingface/transformers';
import { writeFileSync } from 'node:fs';

const prompt = process.argv[2] || 'a red bicycle leaning on a white wall, photo';
const out = process.argv[3] || 'device-generation.png';
env.allowLocalModels = false;
const model_id = 'onnx-community/Janus-Pro-1B-ONNX';
const t0 = Date.now();
const processor = await AutoProcessor.from_pretrained(model_id);
const model = await MultiModalityCausalLM.from_pretrained(model_id, {
  dtype: { prepare_inputs_embeds: 'q4', language_model: 'q4f16', lm_head: 'fp16', gen_head: 'fp16', gen_img_embeds: 'fp16', image_decode: 'fp32' },
  device: 'cpu',
  progress_callback: (p) => { if (p.status === 'progress' && Math.round(p.progress) % 20 === 0) console.log(p.file, Math.round(p.progress) + '%'); },
});
console.log('loaded in', ((Date.now() - t0) / 1000).toFixed(0), 's');
const conversation = [{ role: '<|User|>', content: prompt }];
const inputs = await processor(conversation, { chat_template: 'text_to_image' });
const num_image_tokens = processor.num_image_tokens;
console.log('image tokens', num_image_tokens, 'input ids', inputs.input_ids.dims);
const t1 = Date.now();
const outputs = await model.generate_images({ ...inputs, min_new_tokens: num_image_tokens, max_new_tokens: num_image_tokens, do_sample: true });
console.log('generated in', ((Date.now() - t1) / 1000).toFixed(0), 's; output type', Array.isArray(outputs) ? `array of ${outputs.length} ${outputs[0]?.constructor?.name}` : outputs?.constructor?.name, outputs[0]?.width, outputs[0]?.height, outputs[0]?.channels);
const img = outputs[0];
if (typeof img.save === 'function') await img.save(out);
else writeFileSync(out, Buffer.from(img.data));
console.log('wrote', out);
