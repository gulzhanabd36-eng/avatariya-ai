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

    // 1. Load knowledge base chunks for this role
    let chunks = [];
    try {
      const sbRes = await fetch(
        `${SUPABASE_URL}/rest/v1/knowledge_base?or=(role.eq.${role},role.eq.all)&select=id,content,source_file,category,keywords&limit=500`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      if (sbRes.ok) chunks = await sbRes.json();
    } catch(e) {
      console.error('Supabase error:', e.message);
    }

    // 2. Keyword scoring — threshold 1, top 8 chunks
    const normalize = (str) => str.toLowerCase()
      .replace(/[^а-яёa-z0-9\s]/gi, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);

    const queryWords = normalize(message);
    let contextText = '';
    let hasRelevantDocs = false;
    let sources = [];

    if (Array.isArray(chunks) && chunks.length > 0) {
      const scored = chunks.map(c => {
        const haystack = normalize([
          c.content || '',
          Array.isArray(c.keywords) ? c.keywords.join(' ') : (c.keywords || ''),
          c.category || '',
          c.source_file || ''
        ].join(' '));
        const categoryHay = normalize((c.category || '') + ' ' + (c.source_file || ''));
        let score = 0;
        for (const w of queryWords) {
          if (categoryHay.includes(w)) score += 3;
          else if (haystack.includes(w)) score += 1;
        }
        return { ...c, score };
      }).sort((a, b) => b.score - a.score);

      const top = scored[0]?.score >= 1 ? scored.slice(0, 8) : [];
      hasRelevantDocs = top.length > 0;

      if (top.length > 0) {
        contextText = top.map((c, i) => `[${i + 1}. ${c.source_file || c.category}]\n${c.content}`).join('\n\n───\n\n');
        sources = [...new Set(top.map(c => c.source_file).filter(Boolean))];
      }
    }

    let systemPrompt, userContent;

    if (hasRelevantDocs) {
      // Answer from knowledge base
      systemPrompt = `Ты — AI-ассистент рестопарка Avatariya (Алматы). Отвечай ТОЛЬКО на основе документов из базы знаний.

Правила:
- Отвечай на языке вопроса (русский или казахский)
- Используй ТОЛЬКО информацию из документов ниже — не додумывай
- Если есть изображения ![](url) — включай как есть
- Отвечай чётко и структурированно
- Если документ частично отвечает — дай ответ по документу и укажи источник`;

      userContent = `База знаний:\n\n${contextText}\n\n═══\n\nВопрос: ${message}`;

    } else {
      // No KB docs — give practical GPT advice
      systemPrompt = `Ты — опытный наставник сотрудников рестопарка Avatariya (Алматы). Тебя спрашивают о рабочей ситуации.

Дай конкретный пошаговый совет как действовать. Отвечай практично, без лишних слов.

Правила:
- Отвечай на языке вопроса (русский или казахский)
- Давай чёткие шаги: 1, 2, 3...
- Используй знания о работе в ресторанах, парках развлечений, сервисе
- В конце всегда добавляй: "💡 Для точных регламентов Avatariya — уточни у менеджера смены."`;

      userContent = `Ситуация: ${message}`;
    }

    const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ],
        max_tokens: 2000,
        temperature: hasRelevantDocs ? 0.1 : 0.3
      })
    });

    const gptData = await gptRes.json();
    const answer = gptData.choices?.[0]?.message?.content || 'Не удалось получить ответ.';

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ answer, sources, from_kb: hasRelevantDocs })
    };

  } catch (err) {
    console.error('Chat error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: `Ошибка: ${err.message}` }) };
  }
};
