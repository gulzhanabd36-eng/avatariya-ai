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

    let chunks = [];
    try {
      const sbRes = await fetch(
        `${SUPABASE_URL}/rest/v1/knowledge_base?or=(role.eq.${role},role.eq.all)&select=id,content,source_file,category,keywords&limit=500`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      if (sbRes.ok) chunks = await sbRes.json();
    } catch(e) {}

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
        const haystack = normalize([c.content||'', Array.isArray(c.keywords)?c.keywords.join(' '):(c.keywords||''), c.category||'', c.source_file||''].join(' '));
        const catHay = normalize((c.category||'')+' '+(c.source_file||''));
        let score = 0;
        for (const w of queryWords) {
          if (catHay.includes(w)) score += 3;
          else if (haystack.includes(w)) score += 1;
        }
        return { ...c, score };
      }).sort((a, b) => b.score - a.score);

      const top = scored[0]?.score >= 1 ? scored.slice(0, 10) : [];
      hasRelevantDocs = top.length > 0;
      if (top.length > 0) {
        contextText = top.map((c, i) => `[${i+1}. ${c.source_file||c.category}]\n${(c.content||'').slice(0,4000)}`).join('\n\n───\n\n');
        sources = [...new Set(top.map(c => c.source_file).filter(Boolean))];
      }
    }

    let systemPrompt, userContent;
    if (hasRelevantDocs) {
      systemPrompt = `Ты — AI-ассистент рестопарка Avatariya (Алматы).

КРИТИЧЕСКОЕ ПРАВИЛО: Выводи текст ИМЕННО ТАК, КАК ОН НАПИСАН В ДОКУМЕНТЕ. Не пересказывай, не сжимай, не добавляй свои слова.

Для вопросов про меню, списки, рецепты, ингредиенты, цены — обязательно выводи ВЕСЬ список/текст целиком слово в слово из документа.
НЕ пиши "например" или "в том числе" — выводи ВСЕ пункты.

Otvet na yazyke voprosa (russkiy ili kazakhskiy).
Если есть изображения ![](url) — включай как есть.`;
      userContent = `ДОКУМЕНТЫ ИЗ БАЗЫ ЗНАНИЙ (WORD FOR WORD):\n\n${contextText}\n\n═══\n\nВОПРОС: ${message}\n\nВыведи полный ответ слово в слово из документа. Не сокращай списки.`;
    } else {
      systemPrompt = `Ты — опытный наставник сотрудников рестопарка Avatariya (Алматы). Дай конкретный пошаговый совет. Отвечай на языке вопроса. Шаги: 1, 2, 3... В конце: "💡 Для точных регламентов — уточни у менеджера смены."`;
      userContent = `Ситуация: ${message}`;
    }

    let res;
    try {
      res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent }
          ],
          max_tokens: 3000,
          temperature: 0.0
        })
      });
    } catch (e) {
      return { statusCode: 200, headers, body: JSON.stringify({ answer: `⚠️ Ошибка: ${e.message}`, sources: [], from_kb: false }) };
    }

    const raw = await res.text();
    let data;
    try { data = JSON.parse(raw); }
    catch(e) { return { statusCode: 200, headers, body: JSON.stringify({ answer: `⚠️ ${raw.slice(0,200)}`, sources: [], from_kb: false }) }; }

    if (data.error) {
      return { statusCode: 200, headers, body: JSON.stringify({ answer: `⚠️ OpenAI: ${data.error.message}`, sources: [], from_kb: false }) };
    }

    const answer = data.choices?.[0]?.message?.content || '⚠️ Ответ не получен.';
    return { statusCode: 200, headers, body: JSON.stringify({ answer, sources, from_kb: hasRelevantDocs }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
