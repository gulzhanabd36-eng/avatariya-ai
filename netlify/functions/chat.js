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

  // Role-aware context for AI assistant
  const ROLE_CONTEXT = {
    cashier: `Ты помогаешь КАССИРУ рестопарка развлечений Avatariya (Алматы).
Кассир работает на входе, продаёт браслеты, работает с промокодами, авиками, мобильным приложением.
Если вопрос не связан с работой — вежливо перенаправь.`,

    waiter: `Ты помогаешь ОФИЦИАНТУ ресторана рестопарка Avatariya (Алматы).
Официант обслуживает столы, работает по системе ротации, принимает заказы через приложение.
Если вопрос о зарплате, отпуске, больничном — направь к HR или менеджеру смены.`,

    barmen: `Ты помогаешь БАРМЕНУ рестопарка Avatariya (Алматы).
Бармен готовит напитки по барной карте, работает со сменными закрывашками, следит за чистотой бара.
Если вопрос о зарплате или графике — направь к HR или менеджеру.`,

    operator: `Ты помогаешь ОПЕРАТОРУ АТТРАКЦИОНОВ рестопарка Avatariya (Алматы).
Оператор обслуживает аттракционы, работает с браслетами гостей, следит за безопасностью.
Если вопрос о зарплате или оформлении — направь к HR.`,

    hr: `Ты помогаешь HR-СПЕЦИАЛИСТУ рестопарка Avatariya (Алматы).
HR занимается адаптацией, грейдированием, аттестацией, 5-минутками, карьерным развитием сотрудников.`
  };

  // Who to contact for topics not in knowledge base
  const REDIRECT_RULES = `
Правила перенаправления (используй когда нет информации в базе):
- Вопросы о зарплате, расчётах, задержках → "Обратитесь к HR или бухгалтерии"
- Вопросы о графике, сменах, отгулах → "Уточните у менеджера смены"  
- Вопросы об отпуске, больничном, оформлении → "Обратитесь в HR отдел"
- Жалобы на коллег или конфликты → "Обратитесь к менеджеру или HR"
- Технические проблемы с оборудованием → "Сообщите технической службе или менеджеру"
- Вопросы о штрафах и взысканиях → "Уточните у HR или непосредственного руководителя"
- Вопросы о карьере и повышении → "Обратитесь к HR для обсуждения карьерного плана"
`;

  try {
    const { message, role } = JSON.parse(event.body || '{}');
    if (!message || !role) return { statusCode: 400, headers, body: JSON.stringify({ error: 'message и role обязательны' }) };

    const roleContext = ROLE_CONTEXT[role] || 'Ты помогаешь сотруднику рестопарка Avatariya (Алматы).';

    // 1. Search knowledge base
    let chunks = [];
    let sources = [];

    try {
      const sbRes = await fetch(
        `${SUPABASE_URL}/rest/v1/knowledge_base?or=(role.eq.${role},role.eq.all)&select=id,content,source_file,category,keywords&limit=500`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      if (sbRes.ok) {
        chunks = await sbRes.json();
      }
    } catch(e) {
      console.error('Supabase error:', e.message);
    }

    // 2. Keyword scoring
    const normalize = (str) => str.toLowerCase()
      .replace(/[^а-яёa-z0-9\s]/gi, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);

    const queryWords = normalize(message);
    let contextText = '';
    let hasRelevantDocs = false;

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

      const top = scored[0]?.score > 0 ? scored.slice(0, 5) : [];
      hasRelevantDocs = top.length > 0 && scored[0]?.score >= 2;

      if (top.length > 0) {
        contextText = top.map((c, i) => `[${i + 1}. ${c.source_file || c.category}]\n${c.content}`).join('\n\n───\n\n');
        sources = [...new Set(top.map(c => c.source_file).filter(Boolean))];
      }
    }

    // 3. Build prompt based on whether we have relevant docs
    let systemPrompt;
    let userContent;

    if (hasRelevantDocs) {
      // Answer from knowledge base
      systemPrompt = `${roleContext}

Правила:
- Отвечай на языке вопроса (русский или казахский)
- Используй информацию из документов ниже
- Если есть изображения ![](url) — включай как есть
- Отвечай чётко и структурированно
- Если документ частично отвечает на вопрос — дай ответ по документу, остальное дополни общими знаниями
${REDIRECT_RULES}`;

      userContent = `База знаний:\n\n${contextText}\n\n═══\n\nВопрос: ${message}`;
    } else {
      // No relevant docs — answer with general knowledge + redirect if needed
      systemPrompt = `${roleContext}

Информации по этому вопросу нет в базе знаний. Отвечай используя общие знания.

Правила:
- Отвечай на языке вопроса (русский или казахский)  
- Будь полезным и конкретным
- Если вопрос касается личных рабочих вопросов (зарплата, отпуск, конфликты) — перенаправь к нужному человеку
- Если можешь помочь общими знаниями — помоги
- Всегда заканчивай ответ конкретным советом или следующим шагом
${REDIRECT_RULES}

В конце ответа добавь: "💡 Если нужна точная информация по регламентам Avatariya — уточни у менеджера или HR."`;

      userContent = `Вопрос: ${message}`;
    }

    // 4. GPT-4o
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
        temperature: 0.3
      })
    });

    const gptData = await gptRes.json();
    const answer = gptData.choices?.[0]?.message?.content || 'Не удалось получить ответ.';

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        answer,
        sources,
        from_kb: hasRelevantDocs
      })
    };

  } catch (err) {
    console.error('Chat error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: `Ошибка: ${err.message}` }) };
  }
};
