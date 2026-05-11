const fetch = require('node-fetch');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  try {
    const { message, role } = JSON.parse(event.body || '{}');
    if (!message || !role) return { statusCode: 400, headers, body: JSON.stringify({ error: 'message и role обязательны' }) };

    // 1. Эмбеддинг запроса
    const embRes = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: message })
    });
    const embData = await embRes.json();
    const queryEmb = embData.data[0].embedding;

    // 2. Все чанки по роли
    const sbRes = await fetch(
      `${SUPABASE_URL}/rest/v1/knowledge_base?or=(role.eq.${role},role.eq.all)&select=id,content,source_file,category,keywords,embedding&limit=300`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    if (!sbRes.ok) throw new Error(`Supabase error: ${sbRes.status}`);
    const chunks = await sbRes.json();

    if (!Array.isArray(chunks) || chunks.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ answer: 'В базе знаний нет информации по вашему вопросу.', sources: [] }) };
    }

    // 3. Cosine similarity
    function cosineSim(a, b) {
      let dot = 0, normA = 0, normB = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
      }
      return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    // 4. Ранжирование: векторное + keyword
    const words = message.toLowerCase().split(/[\s,\.!?;:()\/\-]+/).filter(w => w.length > 2);

    const scored = chunks
      .filter(c => c.embedding && Array.isArray(c.embedding))
      .map(c => {
        const vecScore = cosineSim(queryEmb, c.embedding);
        const haystack = [
          c.content || '',
          Array.isArray(c.keywords) ? c.keywords.join(' ') : '',
          c.category || '',
          c.source_file || ''
        ].join(' ').toLowerCase();
        const kwScore = words.reduce((acc, w) => acc + (haystack.includes(w) ? 0.05 : 0), 0);
        return { ...c, score: vecScore + kwScore };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    // 5. Контекст
    const context = scored
      .map((c, i) => `[${i + 1}. ${c.source_file}]\n${c.content}`)
      .join('\n\n───\n\n');

    // 6. GPT-4o
    const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `Ты — AI-ассистент для сотрудников парка развлечений Avatariya (Алматы, Казахстан).

Правила:
- Отвечай на том языке, на котором задан вопрос (русский или казахский)
- Используй ТОЛЬКО информацию из предоставленных документов
- Отвечай чётко и структурированно
- Если в документе есть изображения ![текст](url) — включай их в ответ как есть
- Если есть HTML аккордеон <details><summary>...</summary>...</details> — включай как есть
- Если информации нет — скажи об этом честно
- Не придумывай информацию`
          },
          {
            role: 'user',
            content: `База знаний:\n\n${context}\n\n═══\n\nВопрос сотрудника: ${message}`
          }
        ],
        max_tokens: 2000,
        temperature: 0.1
      })
    });

    const gptData = await gptRes.json();
    const answer = gptData.choices?.[0]?.message?.content || 'Не удалось получить ответ.';
    const sources = [...new Set(scored.map(c => c.source_file).filter(Boolean))];

    return { statusCode: 200, headers, body: JSON.stringify({ answer, sources }) };

  } catch (err) {
    console.error('Chat error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: `Ошибка сервера: ${err.message}` }) };
  }
};