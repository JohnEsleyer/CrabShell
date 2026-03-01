import { getAllSettings } from './db';

export async function getEmbedding(text: string): Promise<number[]> {
    const settings = await getAllSettings();
    const openaiKey = settings.openai_api_key || process.env.OPENAI_API_KEY;

    if (openaiKey) {
        try {
            const response = await fetch('https://api.openai.com/v1/embeddings', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${openaiKey}`
                },
                body: JSON.stringify({
                    input: text,
                    model: 'text-embedding-3-small'
                })
            });
            const data = await response.json() as any;
            if (data.data?.[0]?.embedding) {
                return data.data[0].embedding;
            }
        } catch (e) {
            console.error('OpenAI Embedding Error:', e);
        }
    }

    // Fallback or if no key: Simple hash-based "embedding" 
    // This is NOT a real embedding, but ensures the system doesn't crash 
    // and can still function in a basic way if no OpenAI key is present.
    // In a real production system, you'd want a local model or mandatory API key.
    return fallbackEmbedding(text);
}

function fallbackEmbedding(text: string): number[] {
    const length = 1536; // Match OpenAI size for consistency
    const vec = new Array(length).fill(0);
    for (let i = 0; i < text.length; i++) {
        const char = text.charCodeAt(i);
        vec[i % length] += char / 255;
    }
    // Normalize roughly
    const sum = vec.reduce((a, b) => a + b, 0) || 1;
    return vec.map(v => v / sum);
}

export function cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] ** 2;
        normB += vecB[i] ** 2;
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
