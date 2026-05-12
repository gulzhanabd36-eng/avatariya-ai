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

    // 1. Загружаем ВСЕ чанки по роли (role=роль OR role=all)
    const sbRes = await fetch(
      `${SUPABASE_URL}/rest/v1/knowledge_base?or=(role.eq.${role},role.eq.all)&select=id,content,source_file,category,keywords&limit=500`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    if (!sbRes.ok) throw new Error(`Supabase error: ${sbRes.status} ${await sbRes.text()}`);
    const chunks = await sbRes.json();

    if (!Array.isArray(chunks) || chunks.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ answer: 'В базе знаний нет информации по вашему вопросу.', sources: [] }) };
    }

    // 2. Keyword scoring — улучшенный
    // Нормализуем запрос: убираем знаки, разбиваем на слова длиной > 2
    const normalize = (str) => str.toLowerCase()
      .replace(/[^а-яёa-z0-9\s]/gi, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);

    const queryWords = normalize(message);

    const scored = chunks.map(c => {
      const haystack = normalize([
        c.content || '',
        Array.isArray(c.keywords) ? c.keywords.join(' ') : (c.keywords || ''),
        c.category || '',
        c.source_file || ''
      ].join(' '));

      // Считаем совпадения с весом по позиции (category/source > content)
      const categoryHay = normalize((c.category || '') + ' ' + (c.source_file || ''));
      let score = 0;
      for (const w of queryWords) {
        if (categoryHay.includes(w)) score += 3; // Совпадение в категории = 3 очка
        else if (haystack.includes(w)) score += 1; // Совпадение в тексте = 1 очко
      }
      return { ...c, score };
    }).sort((a, b) => b.score - a.score);

    // Берём топ-5 релевантных (или топ-3 если нет совпадений)
    const top = scored[0].score > 0 ? scored.slice(0, 5) : scored.slice(0, 3);

    // 3. Контекст для GPT
    const context = top
      .map((c, i) => `[${i + 1}. ${c.source_file || c.category}]\n${c.content}`)
      .join('\n\n───\n\n');

    // 4. GPT-4o
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
- Отвечай на языке вопроса (русский или казахский)
- Используй ТОЛЬКО информацию из документов ниже
- Отвечай чётко и структурированно
- Если есть изображения ![](url) — включай их в ответ как есть
- Если есть <details><summary>...</summary>...</details> — включай как есть
- Не придумывай информацию которой нет в документах`
          },
          {
            role: 'user',
            content: `База знаний:\n\n${context}\n\n═══\n\nВопрос: ${message}`
          }
        ],
        max_tokens: 2000,
        temperature: 0.1
      })
    });

    const gptData = await gptRes.json();
    const answer = gptData.choices?.[0]?.message?.content || 'Не удалось получить ответ.';
    const sources = [...new Set(top.map(c => c.source_file).filter(Boolean))];

    return { statusCode: 200, headers, body: JSON.stringify({ answer, sources }) };

  } catch (err) {
    console.error('Chat error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: `Ошибка: ${err.message}` }) };
  }
};
