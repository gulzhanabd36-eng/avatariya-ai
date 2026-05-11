exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  try {
    const { message, role } = JSON.parse(event.body || '{}');

    if (!message || !role) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'message и role обязательны' }) };
    }

    // 1. Получаем чанки из Supabase по роли
    const sbUrl = `${SUPABASE_URL}/rest/v1/knowledge_base?or=(role.eq.${role},role.eq.all)&select=content,source_file,category,keywords&limit=200`;

    const sbRes = await fetch(sbUrl, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });

    if (!sbRes.ok) {
      throw new Error(`Supabase error: ${sbRes.status}`);
    }

    const chunks = await sbRes.json();

    if (!Array.isArray(chunks) || chunks.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ answer: 'В базе знаний нет информации по вашему вопросу.', sources: [] })
      };
    }

    // 2. Keyword scoring для релевантности
    const words = message.toLowerCase()
      .split(/[\s,\.!?;:()\-]+/)
      .filter(w => w.length > 2);

    const scored = chunks.map(chunk => {
      const haystack = [
        chunk.content || '',
        Array.isArray(chunk.keywords) ? chunk.keywords.join(' ') : '',
        chunk.category || '',
        chunk.source_file || ''
      ].join(' ').toLowerCase();

      const score = words.reduce((acc, word) => acc + (haystack.includes(word) ? 1 : 0), 0);
      return { ...chunk, score };
    }).sort((a, b) => b.score - a.score);

    // Берём топ-5 релевантных (или топ-3 если совпадений нет)
    const relevant = scored[0].score > 0 ? scored.slice(0, 5) : scored.slice(0, 3);

    // 3. Контекст для GPT-4o
    const context = relevant
      .map((c, i) => `[${i + 1}. ${c.source_file}]\n${c.content}`)
      .join('\n\n───\n\n');

    // 4. GPT-4o генерирует ответ
    const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
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
- Если в документе есть изображения ![текст](url) — включай их в ответ
- Если есть HTML аккордеон <details><summary>...</summary>...</details> — включай как есть
- Если информации нет — скажи: "В базе знаний нет информации по этому вопросу"
- Не придумывай информацию`
          },
          {
            role: 'user',
            content: `База знаний:\n\n${context}\n\n═══\n\nВопрос сотрудника: ${message}`
          }
        ],
        max_tokens: 2000,
        temperature: 0.2
      })
    });

    const gptData = await gptRes.json();
    const answer = gptData.choices?.[0]?.message?.content || 'Не удалось получить ответ.';
    const sources = [...new Set(relevant.map(c => c.source_file).filter(Boolean))];

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ answer, sources })
    };

  } catch (err) {
    console.error('Chat error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Ошибка сервера. Попробуйте снова.' })
    };
  }
};
