// 10-22: the model picker lists models you can chat and work with. The models.dev catalog also lists live and
// realtime voice models, translation, speech, transcription, embedding and image or video generation models;
// picking one of those fails on the first message. Hidden unless the user turned one on in Manage models.
// Praex models and models the user defined in their own config (no catalog release date) always stay.
const NOT_CHAT =
  /(^|[^a-z])(live|realtime|real-time|translat\w*|tts|speech|audio|transcri\w*|whisper|embed\w*|image|imagen|dall-e|veo|lyria|moderation)([^a-z]|$)/i

type ChatModelInput = {
  id: string
  name: string
  release_date?: string
  capabilities?: {
    toolcall?: boolean
    input?: { text?: boolean }
    output?: { text?: boolean }
  }
}

export function chatModel(providerID: string, model: ChatModelInput) {
  if (providerID === "praex-cloud") return true
  if (!model.release_date) return true
  const caps = model.capabilities
  if (caps?.output?.text === false || caps?.input?.text === false) return false
  if (caps?.toolcall === false) return false
  return !NOT_CHAT.test(model.id) && !NOT_CHAT.test(model.name)
}
