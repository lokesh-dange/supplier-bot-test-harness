/**
 * Contract-shaped stub: does not call Gemini or supplier-bot export.
 * Produces realistic-looking Chinese supplier-bot replies for demo/eval purposes.
 */

const REPLY_TEMPLATES = [
  { pattern: /moq|起订|最小|数量|pcs|件|订/i, reply: '好的，明白了。请问这个价格是含税还是不含税的？另外交期大概多久？', goals: ['moq'] },
  { pattern: /价|price|元|rmb|usd|报价|单价/i, reply: '收到您的报价，谢谢。请问如果数量增加到1000件，价格可以优惠吗？另外运费怎么计算？', goals: ['price'] },
  { pattern: /交期|lead.*time|天|周|发货|生产/i, reply: '了解了，交期可以接受。请问打样需要多久？样品费怎么收？', goals: ['lead_time'] },
  { pattern: /样品|sample|打样/i, reply: '好的，我们需要先看样品确认质量。请问可以寄样品到香港吗？快递费用大概多少？', goals: ['sample'] },
  { pattern: /定制|custom|logo|印刷|颜色/i, reply: '明白，我们需要印Logo。请问贵司有没有做过类似的定制？可以发一些之前的案例给我参考吗？', goals: ['customization'] },
  { pattern: /包装|packing|装箱|纸箱/i, reply: '了解。请问标准包装是怎样的？如果我们有特殊包装要求，费用会增加多少？', goals: ['packaging'] },
  { pattern: /模具|mold|开模|模费/i, reply: '收到模具费信息。请问模具的使用寿命是多少？如果后续返单，还需要再付模具费吗？', goals: ['mold_cost'] },
  { pattern: /认证|certificate|ce|fda|iso/i, reply: '好的，认证信息很重要。请问贵司目前有哪些认证？可以提供认证文件给我们确认吗？', goals: ['certification'] },
  { pattern: /材质|material|面料|材料/i, reply: '了解了材质信息。请问有没有其他材质可选？不同材质对价格的影响大吗？', goals: ['material'] },
  { pattern: /你好|hello|hi|嗨|在吗/i, reply: '您好！我是Sourcy采购助手。我们的客户对贵司的产品很感兴趣，想了解一下具体的合作细节。请问方便聊一下吗？', goals: [] },
  { pattern: /图片|\[图片\]|image|照片|png|jpg|alicdn/i, reply: '收到图片，谢谢！产品看起来不错。请问这款产品的最低起订量是多少？单价是多少？', goals: ['media'] },
  { pattern: /谢谢|thanks|thank|感谢/i, reply: '不客气！那我整理一下信息，确认后会尽快回复您。如果有其他问题请随时联系。', goals: [] },
  { pattern: /ok|好的|可以|没问题|行/i, reply: '好的，收到。那我们接下来确认一下其他细节。请问贵司的付款方式是怎样的？支持TT还是LC？', goals: ['payment'] },
];

const DEFAULT_REPLIES = [
  '好的，信息收到了。请问还有其他我需要了解的吗？比如付款方式或者运输方式？',
  '明白了。为了更好地配合，我想再确认几个细节。请问贵司的产能大概是多少？',
  '了解了。我们的客户对质量要求比较高，请问贵司有没有质检报告或者产品测试数据？',
  '收到，谢谢您的耐心回答。我这边会整理好信息反馈给客户，有进展会第一时间联系您。',
  '好的。请问如果我们确认订单，大概什么时候可以开始生产？',
];

const CLOSING_REPLIES = [
  '非常感谢您提供的信息！我会把所有细节整理好发给客户确认。后续有任何进展我会及时联系您。祝生意兴隆！',
  '好的，信息都记录好了。感谢您的耐心配合！我们会尽快给您反馈，请保持联系。',
];

function findBestReply(content, turnIndex, totalSupplierTurns) {
  const isLast = turnIndex >= totalSupplierTurns - 1;
  if (isLast) {
    return CLOSING_REPLIES[turnIndex % CLOSING_REPLIES.length];
  }

  for (const tpl of REPLY_TEMPLATES) {
    if (tpl.pattern.test(content || '')) {
      return tpl.reply;
    }
  }

  return DEFAULT_REPLIES[turnIndex % DEFAULT_REPLIES.length];
}

function inferToolCallsFromSupplierText(content) {
  const toolCalls = [];
  const c = content || '';
  if (/moq|起订|最小|数量|pcs|件/i.test(c)) {
    toolCalls.push({
      name: 'log_data',
      args: { goalId: 'moq', value: c.match(/\d+/)?.[0] || '[detected]', supplierQuote: c.slice(0, 120) },
    });
  }
  if (/价|price|元|rmb|usd|单价/i.test(c)) {
    toolCalls.push({
      name: 'log_data',
      args: { goalId: 'price', value: c.match(/[\d.]+\s*元|rmb|usd/i)?.[0] || '[detected]', supplierQuote: c.slice(0, 120) },
    });
  }
  if (/\[图片\]|image|照片|附件|png|jpg|jpeg|alicdn/i.test(c)) {
    toolCalls.push({
      name: 'acknowledge_media',
      args: { mediaType: 'image', description: 'Image received from supplier', supplierQuote: c.slice(0, 160) },
    });
  }
  if (/交期|lead.*time|天|周/i.test(c)) {
    toolCalls.push({
      name: 'log_data',
      args: { goalId: 'lead_time', value: c.match(/\d+\s*[天周日]/)?.[0] || '[detected]', supplierQuote: c.slice(0, 120) },
    });
  }
  return toolCalls;
}

export async function handleIncomingMessageSim({ sr, goals, history, contextText }, ctx) {
  const last = history[history.length - 1];
  const content = last?.content ?? '';
  const reply = findBestReply(content, ctx.supplierTurnIndex, ctx.totalSupplierTurns);
  const toolCalls = inferToolCallsFromSupplierText(content);

  if (reply) {
    history.push({ role: 'bot', content: reply });
  }

  const status = ctx.supplierTurnIndex >= ctx.totalSupplierTurns - 1 ? 'completed' : 'continue';
  return { reply, toolCalls, status, history };
}

export async function handleConversationEndSim({ sr, goals, history, botToolTrace }) {
  const extractedGoals = {};
  for (const tc of (botToolTrace || [])) {
    if (tc.name === 'log_data' && tc.args?.goalId) {
      extractedGoals[tc.args.goalId] = tc.args.value || 'collected';
    }
  }

  const goalNames = (goals || []).map(g => g.name || g.id || 'unknown');
  const achievedCount = Object.keys(extractedGoals).length;

  return {
    summaryText: `Conversation completed. ${achievedCount} data points extracted from ${(history || []).filter(m => m.role === 'supplier').length} supplier messages.`,
    signals: [
      { type: 'goal_completion', severity: achievedCount >= 5 ? 'ok' : achievedCount >= 3 ? 'warn' : 'critical', detail: `${achievedCount}/${goalNames.length} goals achieved` },
    ],
    toolCalls: [
      { name: 'schedule_followup', args: { delayHours: 24, reason: 'Standard follow-up after initial conversation', message: '您好，想跟进一下之前聊的合作，请问有最新进展吗？' } },
    ],
    extractedData: extractedGoals,
    goalsAchieved: Object.keys(extractedGoals),
    goalsMissed: goalNames.filter(g => !extractedGoals[g]),
  };
}
