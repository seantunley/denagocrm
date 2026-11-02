/**
 * The owner's voice switches (Settings → Integrations → ElevenLabs) — names only, safe to import anywhere.
 *
 * STT_CUSTOMER_NAMES_KEY: also give Scribe the names of customers with open deals, so they are spelt right in
 * transcripts. OFF unless switched on — it sends customer names to ElevenLabs with every voice note (POPIA: the
 * owner decides).
 */
export const STT_CUSTOMER_NAMES_KEY = "ELEVENLABS_STT_CUSTOMER_NAMES";
export const TTS_MODEL_KEY = "ELEVENLABS_TTS_MODEL";
export const VOICE_SPEED_KEY = "ELEVENLABS_VOICE_SPEED";
