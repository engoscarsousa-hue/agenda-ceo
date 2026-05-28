// ============================================================
//  LITURGIA DO CEO · Service Worker v1.0
//  Arquivo: sw.js — deve ficar na MESMA PASTA da agenda HTML
//
//  O que faz:
//  1. Mantém notificações ativas mesmo com o browser fechado
//  2. Recebe mensagens da agenda via postMessage
//  3. Agenda notificações persistentes por bloco/tipo
//  4. Toca sons distintos por urgência (via vibration API)
// ============================================================

const SW_VERSION = 'liturgia-ceo-v1.0';
const CACHE_NAME = 'liturgia-ceo-cache-v1';

// Arquivos para cache offline (agenda funciona sem internet)
const CACHE_FILES = [
  './',
  './liturgia-ceo-v6.html'
];

// ── INSTALL ───────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(CACHE_FILES).catch(() => {
        // Falha silenciosa — cache é opcional
      });
    })
  );
  self.skipWaiting();
});

// ── ACTIVATE ──────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── FETCH (cache offline) ─────────────────────────────────
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

// ── RECEBER MENSAGENS DA AGENDA ───────────────────────────
// A agenda envia { type, payload } via postMessage
self.addEventListener('message', event => {
  const { type, payload } = event.data || {};

  switch(type) {

    // Agenda todos os alertas do dia de uma vez
    case 'SCHEDULE_ALL':
      scheduleAll(payload.items, payload.config);
      break;

    // Cancela todos os alertas (ex: ao marcar tarefa como concluída)
    case 'CANCEL_ALL':
      pendingNotifications.forEach(n => clearTimeout(n.timer));
      pendingNotifications = [];
      break;

    // Cancela alerta de uma tarefa específica
    case 'CANCEL_ONE':
      cancelOne(payload.id);
      break;

    // Teste imediato (botão "Testar notificação" nas configurações)
    case 'TEST_NOW':
      fireNotification({
        id:        'test',
        task:      'TESTE DE NOTIFICAÇÃO — LITURGIA CEO',
        time:      new Date().toTimeString().slice(0,5),
        blockType: payload.blockType || 'Estrategico',
        type:      payload.type || 'Estratégico'
      }, 0);
      break;
  }
});

// ── ARMAZENAMENTO DE TIMERS ────────────────────────────────
let pendingNotifications = [];

// ── CONFIG DE ANTECEDÊNCIA POR BLOCO ──────────────────────
// Quantos minutos antes do compromisso o alerta dispara
const BLOCK_LEAD_MINUTES = {
  Reino:          30,   // Devocional — precisa de preparação espiritual
  Estrategico:    20,   // S&OP / reunião de diretoria — precisa revisar dados
  Comercial:      15,   // Reunião com cliente — padrão
  Operacional:    15,   // Visita à fábrica / fornecedor
  Administrativo: 10,   // Financeiro / adm
  Pessoal:        10    // Compromissos pessoais
};

// ── CONFIG DE ÍCONE POR BLOCO ──────────────────────────────
const BLOCK_ICONS = {
  Reino:          '✝',
  Estrategico:    '🎯',
  Comercial:      '🤝',
  Operacional:    '🏭',
  Administrativo: '💼',
  Pessoal:        '👤'
};

// ── CONFIG DE COR (badge) POR BLOCO ───────────────────────
const BLOCK_BADGE_COLOR = {
  Reino:          '#B8860B',
  Estrategico:    '#22C55E',
  Comercial:      '#F59E0B',
  Operacional:    '#3B82F6',
  Administrativo: '#64748B',
  Pessoal:        '#8B5CF6'
};

// ── AGENDAR TODOS OS ALERTAS DO DIA ───────────────────────
function scheduleAll(items, config = {}) {
  // Limpar alertas anteriores
  pendingNotifications.forEach(n => clearTimeout(n.timer));
  pendingNotifications = [];

  const now = new Date();

  items.forEach(item => {
    if (!item.date || !item.time || item.completed) return;

    const [h, m] = item.time.split(':').map(Number);
    const taskTime  = new Date(item.date + 'T' + item.time + ':00');

    // Lead time personalizado por bloco (ou padrão 15 min)
    const leadMin = config.leadMinutes?.[item.blockType]
                    ?? BLOCK_LEAD_MINUTES[item.blockType]
                    ?? 15;

    const alertTime = new Date(taskTime.getTime() - leadMin * 60 * 1000);
    const delta     = alertTime.getTime() - now.getTime();

    if (delta <= 0) return; // já passou

    const timer = setTimeout(() => {
      fireNotification(item, leadMin);
      cancelOne(item.id); // remove da lista após disparar
    }, delta);

    pendingNotifications.push({ id: item.id, timer });
  });
}

// ── CANCELAR UM ALERTA ────────────────────────────────────
function cancelOne(id) {
  const idx = pendingNotifications.findIndex(n => String(n.id) === String(id));
  if (idx !== -1) {
    clearTimeout(pendingNotifications[idx].timer);
    pendingNotifications.splice(idx, 1);
  }
}

// ── DISPARAR A NOTIFICAÇÃO ────────────────────────────────
function fireNotification(item, leadMin) {
  const icon    = BLOCK_ICONS[item.blockType]    || '📋';
  const badge   = BLOCK_BADGE_COLOR[item.blockType] || '#0F172A';
  const urgency = getUrgencyLevel(item);

  // Título e corpo da notificação
  const title = `${icon} EM ${leadMin} MIN — ${item.task.toUpperCase()}`;
  const body  = buildBody(item, leadMin);

  // Opções da notificação nativa do sistema operacional
  const options = {
    body,
    icon:      buildIconSVG(icon, badge),
    badge:     buildIconSVG('✝', '#B8860B'),
    tag:       `liturgia-${item.id}`,           // agrupa notificações da mesma tarefa
    renotify:  false,
    silent:    false,
    vibrate:   getVibrationPattern(urgency),     // padrão vibração no Android
    data:      { itemId: item.id, url: './' },
    actions: [
      { action: 'done',  title: '✓ Concluir' },
      { action: 'snooze', title: '⏱ +5 min'  }
    ]
  };

  self.registration.showNotification(title, options);
}

// ── CONSTRUIR CORPO DA MENSAGEM ────────────────────────────
function buildBody(item, leadMin) {
  const parts = [`⏰ ${item.time}`];
  if (item.type)     parts.push(item.type.toUpperCase());
  if (item.intencao) parts.push(`✝ ${item.intencao.toUpperCase()}`);
  return parts.join('  ·  ');
}

// ── NÍVEL DE URGÊNCIA ──────────────────────────────────────
function getUrgencyLevel(item) {
  if (item.type === 'Urgente')   return 'high';
  if (item.blockType === 'Reino') return 'spiritual';
  if (['Estrategico','Comercial'].includes(item.blockType)) return 'medium';
  return 'low';
}

// ── PADRÃO DE VIBRAÇÃO POR URGÊNCIA ───────────────────────
// [vibra, pausa, vibra, pausa...] em ms
function getVibrationPattern(urgency) {
  const patterns = {
    high:      [200, 100, 200, 100, 400],  // urgente — 3 pulsos
    spiritual: [100, 200, 100],             // reino   — suave duplo
    medium:    [200, 100, 200],             // médio   — duplo
    low:       [150]                        // leve    — simples
  };
  return patterns[urgency] || patterns.low;
}

// ── ÍCONE SVG INLINE ──────────────────────────────────────
function buildIconSVG(emoji, bg) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>
    <rect width='100' height='100' rx='20' fill='${bg}'/>
    <text x='50' y='72' font-size='55' text-anchor='middle'>${emoji}</text>
  </svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

// ── CLIQUE NA NOTIFICAÇÃO ─────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const { action } = event;
  const { itemId, url } = event.notification.data || {};

  if (action === 'done') {
    // Envia mensagem para a agenda marcar como concluída
    event.waitUntil(
      self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(c => c.postMessage({ type: 'COMPLETE_ITEM', id: itemId }));
        if (clients.length === 0) return self.clients.openWindow(url || './');
      })
    );
  } else if (action === 'snooze') {
    // Re-agenda em 5 minutos
    setTimeout(() => {
      self.registration.showNotification(
        `⏰ LEMBRETE: ${event.notification.title.replace(/^.* — /, '')}`,
        { ...event.notification, body: 'ADIADO 5 MINUTOS', tag: itemId + '-snooze' }
      );
    }, 5 * 60 * 1000);
  } else {
    // Clique no corpo — abre a agenda
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        const existing = clients.find(c => c.url.includes('liturgia'));
        if (existing) { existing.focus(); return; }
        return self.clients.openWindow(url || './');
      })
    );
  }
});

// ── FECHAR NOTIFICAÇÃO ────────────────────────────────────
self.addEventListener('notificationclose', event => {
  // Registrar que o usuário fechou sem agir — analytics futuro
});
