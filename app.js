(() => {
  'use strict';

  // --- Configuración PocketBase y Claves Locales ---
  // URL de PocketBase dinámica (usa el dominio HTTPS público con fallback a IP local)
  const POCKETBASE_URL = window.location.protocol === 'https:' ? 'https://martiperpocketbase.duckdns.org' : (window.location.hostname === '192.168.1.109' || window.location.hostname === 'localhost' ? 'http://192.168.1.109:8090' : 'https://martiperpocketbase.duckdns.org');
  const STORAGE_KEY_PREFIX = 'multiproduct-savings-user-';
  const LEGACY_KEY = 'multiproduct-savings-v1';

  // Inicializar cliente PocketBase
  let pb = null;
  let isOnline = false;
  try {
    if (typeof PocketBase !== 'undefined') {
      pb = new PocketBase(POCKETBASE_URL);
      pb.autoCancellation(false);
    }
  } catch (err) {
    console.warn('No se pudo inicializar PocketBase SDK:', err);
  }

  // --- Presets de Imágenes (Archivos SVG y PNG en media/) ---
  const PRESETS = {
    iphone: { id: 'iphone', label: 'iPhone', icon: '📱', src: 'media/iPhone20.png' },
    macbook: { id: 'macbook', label: 'MacBook', icon: '💻', src: 'media/macbook.svg' },
    ipad: { id: 'ipad', label: 'iPad / Tablet', icon: '📐', src: 'media/ipad.svg' },
    watch: { id: 'watch', label: 'Apple Watch', icon: '⌚', src: 'media/watch.svg' },
    airpods: { id: 'airpods', label: 'AirPods Max', icon: '🎧', src: 'media/airpods.svg' },
    console: { id: 'console', label: 'Consola / Play', icon: '🎮', src: 'media/console.svg' },
    trip: { id: 'trip', label: 'Viaje / Vuelo', icon: '✈️', src: 'media/trip.svg' },
    vehicle: { id: 'vehicle', label: 'Coche / Moto', icon: '🚗', src: 'media/vehicle.svg' }
  };

  // --- Estado de la Aplicación ---
  const state = {
    user: null,
    products: [],
    activeProductId: null,
    currentFilter: 'all',
    formType: 'deposit',
    hasCelebrated: false
  };

  // --- Categorías de Aportaciones ---
  const CATEGORIES = {
    wallapop: { label: 'Venta / Segunda mano', icon: '📦' },
    salary: { label: 'Sueldo / Nómina', icon: '💼' },
    gift: { label: 'Regalo / Cumple', icon: '🎁' },
    saving: { label: 'Recorte / Ahorro', icon: '☕' },
    other: { label: 'Otro ingreso', icon: '✨' }
  };

    function getUserId() {
    if (!state.user) return null;
    // Si el usuario tiene usersId mapeado o su id es de users
    return state.user.usersId || state.user.id;
  }

  function getUserStorageKey() {
    return state.user ? `${STORAGE_KEY_PREFIX}${state.user.id}` : LEGACY_KEY;
  }

  // --- Carga Local aislada por usuario ---
  function loadLocalData() {
    try {
      const key = getUserStorageKey();
      const raw = localStorage.getItem(key) || localStorage.getItem(LEGACY_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.products) && parsed.products.length > 0) {
          state.products = parsed.products;
          return;
        }
      }

      state.products = [
        {
          id: 'prod-iphone-default',
          name: 'iPhone 20',
          goal: 2000,
          imagePreset: 'iphone',
          customImage: '',
          targetDate: '',
          created: Date.now(),
          entries: []
        }
      ];
      saveLocalData();
    } catch (err) {
      console.warn('Error al cargar datos locales:', err);
    }
  }

  function saveLocalData() {
    try {
      const key = getUserStorageKey();
      localStorage.setItem(key, JSON.stringify({
        products: state.products
      }));
    } catch (e) {
      console.warn('Error al guardar en localStorage:', e);
    }
  }

  // --- Sincronización Segura con PocketBase (Filtrado por usuario) ---
  async function loadDataFromPocketBase() {
    if (!pb || !pb.authStore.isValid || !state.user) return false;
    try {
      // 1. Obtener SOLO los productos del usuario autenticado
      const pRecords = await pb.collection('products').getFullList({
        filter: `user = "${getUserId()}"`,
        sort: 'created'
      });

      // 2. Obtener SOLO los movimientos del usuario autenticado
      const eRecords = await pb.collection('entries').getFullList({
        filter: `user = "${getUserId()}"`,
        sort: 'created'
      });

      if (pRecords.length === 0) {
        // Si el usuario aún no tiene productos en PocketBase pero tiene locales, migrarlos vinculando su user ID
        if (state.products.length > 0 && state.products[0].id.startsWith('prod-')) {
          await migrateLocalToPocketBase();
          return true;
        }
        state.products = [];
        saveLocalData();
        return true;
      }

      const prevSnapshot = JSON.stringify(state.products.map(p => ({
        id: p.id,
        entries: (p.entries || []).map(e => ({ id: e.id, amount: e.amount, date: e.date, type: e.type, concept: e.concept }))
      })));

      state.products = pRecords.map(p => {
        let imgSrc = p.custom_image || '';
        if (p.image) {
          imgSrc = pb.files.getURL(p, p.image);
        }

        // Combinar con los movimientos de PocketBase preservando los no sincronizados o temporales
        const serverEntries = eRecords
          .filter(e => e.product === p.id)
          .map(e => ({
            id: e.id,
            concept: e.concept || '',
            amount: Number(e.amount) || 0,
            category: e.category || 'saving',
            type: e.type || 'deposit',
            date: e.date || new Date().toISOString().slice(0, 10),
            created: new Date(e.created).getTime() || Date.now()
          }));

        // Los movimientos de PocketBase son la fuente de verdad (serverEntries).
        // Solo conservamos como 'pendientes' las entradas locales temporales que todavía no
        // han recibido ID de servidor (por ejemplo mientras se crea el registro offline/asíncrono).
        // Cualquier entrada con ID de PocketBase (15 caracteres alfanuméricos) que ya no exista
        // en serverEntries significa que ha sido eliminada en otro dispositivo y debe borrarse localmente.
        const currentProduct = state.products.find(sp => sp.id === p.id);
        const pendingEntries = (currentProduct && Array.isArray(currentProduct.entries))
          ? currentProduct.entries.filter(le => {
              const isTempId = !le.id || le.id.includes('-') || le.id.length !== 15;
              return isTempId && !serverEntries.some(se => se.id === le.id);
            })
          : [];

        const entries = [...serverEntries, ...pendingEntries];

        return {
          id: p.id,
          name: p.name,
          goal: Number(p.goal) || 1,
          targetDate: p.target_date || '',
          customImage: imgSrc,
          created: new Date(p.created).getTime() || Date.now(),
          entries
        };
      });

      const newSnapshot = JSON.stringify(state.products.map(p => ({
        id: p.id,
        entries: (p.entries || []).map(e => ({ id: e.id, amount: e.amount, date: e.date, type: e.type, concept: e.concept }))
      })));

      saveLocalData();
      isOnline = true;
      return prevSnapshot !== newSnapshot;
    } catch (err) {
      console.warn('PocketBase offline o no accesible:', err);
      isOnline = false;
      return false;
    }
  }

  async function migrateLocalToPocketBase() {
    if (!pb || !state.user) return;
    try {
      for (const p of state.products) {
        const pRecord = await pb.collection('products').create({
          user: getUserId(),
          name: p.name,
          goal: p.goal,
          target_date: p.targetDate || '',
          custom_image: p.customImage || ''
        });

        p.id = pRecord.id;

        if (Array.isArray(p.entries)) {
          for (const e of p.entries) {
            const eRecord = await pb.collection('entries').create({
              user: getUserId(),
              product: pRecord.id,
              concept: e.concept,
              amount: e.amount,
              category: e.category,
              type: e.type,
              date: e.date
            });
            e.id = eRecord.id;
          }
        }
      }
      saveLocalData();
      isOnline = true;
    } catch (err) {
      console.warn('Error durante la migración a PocketBase:', err);
    }
  }

  // Suscripción en tiempo real a cambios de PocketBase y reconexión activa
  let isSubscribed = false;
  let pollingIntervalId = null;

  async function subscribeRealtime() {
    if (!pb || !state.user) return;
    try {
      // Si ya existían listeners previos en PocketBase SDK, desuscribir de forma limpia
      try {
        await pb.collection('products').unsubscribe('*');
        await pb.collection('entries').unsubscribe('*');
      } catch (_) {}

      await pb.collection('products').subscribe('*', async () => {
        await loadDataFromPocketBase();
        refreshCurrentView();
      });

      await pb.collection('entries').subscribe('*', async () => {
        await loadDataFromPocketBase();
        refreshCurrentView();
      });
      isSubscribed = true;
    } catch (err) {
      console.warn('No se pudo suscribir a realtime de PocketBase:', err);
      isSubscribed = false;
    }

    // Iniciar polling de respaldo periódico automático (cada 5s cuando la pestaña esté activa)
    // Esto garantiza sincronización perfecta incluso si SSE se suspende en iOS Safari o Mac
    startAutoPolling();
  }

  function startAutoPolling() {
    if (pollingIntervalId) clearInterval(pollingIntervalId);
    pollingIntervalId = setInterval(async () => {
      if (document.visibilityState === 'visible' && state.user && pb) {
        const changed = await loadDataFromPocketBase();
        if (changed) {
          refreshCurrentView();
        }
      }
    }, 5000);
  }

  // Sincronización manual bajo demanda disparada por el usuario o al volver a la app
  async function triggerManualSync(buttonElement) {
    if (!pb || !state.user) return;
    const icons = document.querySelectorAll('#btn-sync-catalog .chip-icon, #btn-sync-detail .chip-icon');
    icons.forEach(ic => ic.style.animation = 'spin 0.8s linear infinite');
    try {
      await loadDataFromPocketBase();
      refreshCurrentView();
      // Asegurar que la suscripción realtime siga viva
      if (!isSubscribed) {
        await subscribeRealtime();
      }
    } catch (e) {
      console.warn('Error en sincronización manual:', e);
    } finally {
      setTimeout(() => {
        icons.forEach(ic => ic.style.animation = '');
      }, 500);
    }
  }

  function refreshCurrentView() {
    if (state.activeProductId) {
      renderDetail();
    } else {
      renderCatalog();
    }
  }

  // --- Utilidades ---
  const euros = val => new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 2
  }).format(val);

  const safeDate = str => {
    const d = new Date(`${str}T12:00:00`);
    return Number.isNaN(d.getTime()) ? new Date() : d;
  };

  function getProductTotal(product) {
    if (!product || !Array.isArray(product.entries)) return 0;
    return product.entries.reduce((sum, item) => {
      const amt = Number(item.amount) || 0;
      return item.type === 'withdraw' ? sum - amt : sum + amt;
    }, 0);
  }

  function getProductImageSrc(product) {
    if (product.customImage) return product.customImage;
    const preset = PRESETS[product.imagePreset] || PRESETS.iphone;
    return preset.src;
  }

  // Animación numérica suave
  let currentAnimatedTotal = 0;
  function animateValue(elem, start, end, duration = 500) {
    if (start === end) {
      elem.textContent = euros(end);
      return;
    }
    const startTime = performance.now();
    function update(now) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const ease = 1 - Math.pow(1 - progress, 3);
      const val = start + (end - start) * ease;
      elem.textContent = euros(val);
      if (progress < 1) requestAnimationFrame(update);
    }
    requestAnimationFrame(update);
  }

  // --- Canvas de Celebración (Confeti al 100%) ---
  const canvas = document.querySelector('#celebration-canvas');
  let ctx = canvas ? canvas.getContext('2d') : null;
  let particles = [];
  let animId = null;

  function resizeCanvas() {
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function triggerCelebration() {
    if (!canvas) return;
    resizeCanvas();
    canvas.style.display = 'block';
    particles = [];
    const colors = ['#29472e', '#4f7255', '#a5c49f', '#c9823b', '#e2b36f', '#ffffff'];
    for (let i = 0; i < 90; i++) {
      particles.push({
        x: canvas.width / 2 + (Math.random() - 0.5) * 60,
        y: canvas.height * 0.45,
        vx: (Math.random() - 0.5) * 14,
        vy: -Math.random() * 12 - 4,
        size: Math.random() * 7 + 4,
        color: colors[Math.floor(Math.random() * colors.length)],
        rotation: Math.random() * 360,
        rotSpeed: (Math.random() - 0.5) * 10,
        gravity: 0.28,
        opacity: 1
      });
    }
    cancelAnimationFrame(animId);
    animateParticles();
  }

  function animateParticles() {
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let active = 0;

    particles.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.gravity;
      p.rotation += p.rotSpeed;
      p.opacity -= 0.007;

      if (p.opacity > 0 && p.y < canvas.height + 20) {
        active++;
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.opacity);
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      }
    });

    if (active > 0) {
      animId = requestAnimationFrame(animateParticles);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (canvas) canvas.style.display = 'none';
    }
  }

  window.addEventListener('resize', () => {
    if (canvas) {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
  });

  // --- Navegación entre Vistas ---
  const viewCatalog = document.querySelector('#view-catalog');
  const viewDetail = document.querySelector('#view-detail');

  // Modal de confirmación estilizado y no bloqueante (funciona 100% en iOS Safari)
  const confirmModal = document.querySelector('#confirm-modal');
  const confirmTitle = document.querySelector('#confirm-modal-title');
  const confirmDesc = document.querySelector('#confirm-modal-desc');
  const btnConfirmOk = document.querySelector('#btn-confirm-ok');
  const btnConfirmCancel = document.querySelector('#btn-confirm-cancel');
  let currentConfirmResolver = null;

  function askConfirmation({ title = '¿Estás seguro?', message = 'Esta acción no se puede deshacer.', okText = 'Eliminar', danger = true }) {
    return new Promise(resolve => {
      if (!confirmModal) {
        resolve(window.confirm(`${title}\n${message}`));
        return;
      }
      currentConfirmResolver = resolve;
      if (confirmTitle) confirmTitle.textContent = title;
      if (confirmDesc) confirmDesc.textContent = message;
      if (btnConfirmOk) {
        btnConfirmOk.textContent = okText;
        btnConfirmOk.className = danger ? 'confirm-dialog-danger' : 'btn-primary';
      }
      openModal(confirmModal);
    });
  }

  if (btnConfirmOk) {
    btnConfirmOk.addEventListener('click', () => {
      closeModal(confirmModal);
      if (currentConfirmResolver) {
        currentConfirmResolver(true);
        currentConfirmResolver = null;
      }
    });
  }

  if (btnConfirmCancel) {
    btnConfirmCancel.addEventListener('click', () => {
      closeModal(confirmModal);
      if (currentConfirmResolver) {
        currentConfirmResolver(false);
        currentConfirmResolver = null;
      }
    });
  }

  function showCatalog() {
    state.activeProductId = null;
    viewCatalog.hidden = false;
    viewDetail.hidden = true;
    window.location.hash = '';
    renderCatalog();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function showDetail(productId) {
    const product = state.products.find(p => p.id === productId);
    if (!product) {
      showCatalog();
      return;
    }
    state.activeProductId = productId;
    state.hasCelebrated = false;
    viewCatalog.hidden = true;
    viewDetail.hidden = false;
    window.location.hash = productId;
    renderDetail();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // --- Renderizado del Catálogo (Home) ---
  function renderCatalog() {
    let globalSaved = 0;
    let globalGoal = 0;
    let completedCount = 0;

    state.products.forEach(p => {
      const saved = Math.max(0, getProductTotal(p));
      globalSaved += saved;
      globalGoal += Number(p.goal) || 0;
      if (saved >= p.goal && p.goal > 0) completedCount++;
    });

    const globalProgress = globalGoal > 0 ? Math.min(100, (globalSaved / globalGoal) * 100) : 0;

    // Resumen Global
    document.querySelector('#catalog-global-saved').textContent = euros(globalSaved);
    document.querySelector('#catalog-global-goal').textContent = `/ ${euros(globalGoal)}`;
    document.querySelector('#catalog-global-fill').style.width = `${globalProgress}%`;
    document.querySelector('#catalog-global-percent').textContent = `${new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(globalProgress)}% completado`;
    document.querySelector('#catalog-active-count').textContent = `${state.products.length} ${state.products.length === 1 ? 'meta' : 'metas'}`;
    document.querySelector('#catalog-completed-count').textContent = `${completedCount} ${completedCount === 1 ? 'conseguida' : 'conseguidas'}`;

    // Renderizado de las tarjetas
    const grid = document.querySelector('#products-grid');
    grid.innerHTML = '';

    state.products.forEach(product => {
      const saved = Math.max(0, getProductTotal(product));
      const goal = Number(product.goal) || 1;
      const progress = Math.min(100, Math.max(0, (saved / goal) * 100));
      const isCompleted = saved >= goal;
      const imgSrc = getProductImageSrc(product);

      const card = document.createElement('div');
      card.className = 'product-card';
      card.addEventListener('click', e => {
        if (e.target.closest('.card-action-btn')) return;
        showDetail(product.id);
      });

      // Top bar
      const top = document.createElement('div');
      top.className = 'card-top';

      const statusTag = document.createElement('span');
      statusTag.className = `product-status-tag ${isCompleted ? 'completed' : ''}`;
      statusTag.innerHTML = isCompleted ? '★ ¡Conseguido!' : `${Math.round(progress)}% alcanzado`;

      const actions = document.createElement('div');
      actions.className = 'card-actions';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'card-action-btn';
      editBtn.title = 'Editar datos del producto';
      editBtn.innerHTML = '✎';
      editBtn.addEventListener('click', e => {
        e.stopPropagation();
        openProductModal(product);
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'card-action-btn delete';
      delBtn.title = 'Eliminar meta';
      delBtn.innerHTML = '×';
      delBtn.addEventListener('click', async e => {
        e.stopPropagation();
        const confirmed = await askConfirmation({
          title: `¿Eliminar "${product.name}"?`,
          message: 'Se eliminará esta meta de ahorro y todo su historial de movimientos.',
          okText: 'Eliminar meta'
        });
        if (confirmed) {
          if (pb && product.id && !product.id.startsWith('prod-')) {
            try {
              await pb.collection('products').delete(product.id);
            } catch (err) {
              console.warn('Error borrando en PocketBase:', err);
            }
          }
          state.products = state.products.filter(p => p.id !== product.id);
          saveLocalData();
          renderCatalog();
        }
      });

      actions.append(editBtn, delBtn);
      top.append(statusTag, actions);

      // Visual wrap
      const visualWrap = document.createElement('div');
      visualWrap.className = 'product-visual-wrap';

      const img = document.createElement('img');
      img.className = 'product-visual-img';
      img.src = imgSrc;
      img.alt = product.name;

      const fillOverlay = document.createElement('div');
      fillOverlay.className = 'product-visual-fill-overlay';
      fillOverlay.style.height = `${progress}%`;

      visualWrap.append(img, fillOverlay);

      // Info
      const info = document.createElement('div');
      info.className = 'product-info';

      const title = document.createElement('h3');
      title.className = 'product-card-title';
      title.textContent = product.name;

      const subtitle = document.createElement('p');
      subtitle.className = 'product-card-subtitle';
      subtitle.textContent = product.targetDate ? `Meta: ${product.targetDate}` : `${product.entries?.length || 0} movimientos`;

      info.append(title, subtitle);

      // Money line
      const moneyLine = document.createElement('div');
      moneyLine.className = 'product-card-money';
      const savedSpan = document.createElement('span');
      savedSpan.className = 'saved';
      savedSpan.textContent = euros(saved);
      const goalSpan = document.createElement('span');
      goalSpan.className = 'goal';
      goalSpan.textContent = `/ ${euros(goal)}`;
      moneyLine.append(savedSpan, goalSpan);

      // Progress bar
      const progressTrack = document.createElement('div');
      progressTrack.className = 'product-card-progress';
      const progressBar = document.createElement('div');
      progressBar.className = 'product-card-progress-bar';
      progressBar.style.width = `${progress}%`;
      progressTrack.append(progressBar);

      // Action button
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'btn-open-detail';
      openBtn.innerHTML = 'Ver hucha <span>↗</span>';

      card.append(top, visualWrap, info, moneyLine, progressTrack, openBtn);
      grid.append(card);
    });

    // Tarjeta para crear nuevo producto
    const addCard = document.createElement('button');
    addCard.type = 'button';
    addCard.className = 'add-product-card';
    addCard.innerHTML = `
      <div class="add-product-icon-wrap">+</div>
      <h3>Nueva Meta de Ahorro</h3>
      <p>Añade otro producto o viaje para empezar a ahorrar.</p>
    `;
    addCard.addEventListener('click', e => {
      e.preventDefault();
      openProductModal();
    });
    grid.append(addCard);
  }

  // --- Renderizado de la Vista Detalle ---
  function renderDetail() {
    const product = state.products.find(p => p.id === state.activeProductId);
    if (!product) return;

    const goal = Number(product.goal) || 1;
    const total = getProductTotal(product);
    const safeTotal = Math.max(0, total);
    const progress = Math.min(100, Math.max(0, (safeTotal / goal) * 100));
    const remaining = Math.max(0, goal - safeTotal);
    const imgSrc = getProductImageSrc(product);

    // Actualizar textos y títulos
    const brandName = product.name.toUpperCase();
    const topbarGoalLabel = document.querySelector('#topbar-goal-label');
    if (topbarGoalLabel) topbarGoalLabel.innerHTML = `OBJETIVO <strong>${euros(goal)}</strong>`;
    const heroModelTag = document.querySelector('#hero-model-tag');
    if (heroModelTag) heroModelTag.textContent = `${product.name}.`;
    const goalTotalDisplay = document.querySelector('#goal-total-display');
    if (goalTotalDisplay) goalTotalDisplay.textContent = `/ ${euros(goal)}`;
    const stageModelBadge = document.querySelector('#stage-model-badge');
    if (stageModelBadge) stageModelBadge.textContent = brandName;
    const stageCode = document.querySelector('#stage-code');
    if (stageCode) stageCode.textContent = product.name.slice(0, 10).toUpperCase();

    // Actualizar imágenes del visor (silueta y color)
    const silhouetteImg = document.querySelector('#detail-img-silhouette');
    const colorImg = document.querySelector('#detail-img-color');
    silhouetteImg.src = imgSrc;
    colorImg.src = imgSrc;

    // Animación del total
    const savedTotalElem = document.querySelector('#saved-total');
    animateValue(savedTotalElem, currentAnimatedTotal, safeTotal);
    currentAnimatedTotal = safeTotal;

    // Barra de progreso y recorte de imagen
    document.documentElement.style.setProperty('--progress', `${progress}%`);
    document.querySelector('#progress-fill').style.width = `${progress}%`;
    const bar = document.querySelector('.progress-track');
    bar.setAttribute('aria-valuenow', String(safeTotal));
    bar.setAttribute('aria-valuemax', String(goal));

    const progressFormatted = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(progress);
    document.querySelector('#progress-label').textContent = `${progressFormatted}% del objetivo`;
    document.querySelector('#remaining-label').textContent = safeTotal >= goal ? '¡Objetivo conseguido!' : `Te faltan ${euros(remaining)}`;

    colorImg.style.clipPath = `inset(${100 - progress}% 0 0 0)`;

    // Indicador de nivel
    const levelIndicator = document.querySelector('#level-indicator');
    const levelTag = document.querySelector('#level-tag');
    if (levelIndicator && levelTag) {
      levelIndicator.style.bottom = `${progress}%`;
      levelIndicator.style.opacity = progress > 0 ? '1' : '0';
      levelTag.textContent = `${Math.round(progress)}%`;
    }

    // Nota de revelado y confeti
    const note = document.querySelector('#reveal-note');
    if (progress >= 100) {
      note.textContent = `¡Felicidades! Meta de ${product.name} conseguida 🎉`;
      note.style.opacity = '1';
      if (!state.hasCelebrated) {
        state.hasCelebrated = true;
        triggerCelebration();
      }
    } else if (progress > 2) {
      note.style.opacity = '0';
      state.hasCelebrated = false;
    } else {
      note.textContent = `Empieza a ahorrar para revelar tu ${product.name}`;
      note.style.opacity = '1';
      state.hasCelebrated = false;
    }

    // Estadísticas inteligentes
    const stats = computeStats(product, safeTotal, goal);
    document.querySelector('#stat-monthly').textContent = stats.monthlyRate > 0 ? `${euros(stats.monthlyRate)}/mes` : '0 €/mes';
    document.querySelector('#stat-eta').textContent = stats.etaText;
    document.querySelector('#stat-avg').textContent = euros(stats.avgDeposit);

    // Contador de movimientos
    const validCount = product.entries ? product.entries.length : 0;
    document.querySelector('#entry-count').textContent = `${validCount} ${validCount === 1 ? 'movimiento' : 'movimientos'}`;

    // Renderizar lista de movimientos de este producto
    renderEntriesList(product);
  }

  function computeStats(product, total, goal) {
    const deposits = (product.entries || []).filter(e => e.type !== 'withdraw');
    if (deposits.length === 0) {
      return { monthlyRate: 0, etaText: 'Sin datos aún', avgDeposit: 0 };
    }

    const avgDeposit = total > 0 ? (total / deposits.length) : 0;
    const dates = product.entries.map(e => safeDate(e.date).getTime()).filter(t => !Number.isNaN(t));
    const minDate = dates.length ? Math.min(...dates) : Date.now();
    const daysSpan = Math.max(1, (Date.now() - minDate) / (1000 * 60 * 60 * 24));
    const monthlyRate = (total / daysSpan) * 30.42;

    let etaText = 'Calculando...';
    if (total >= goal) {
      etaText = '¡Meta lograda!';
    } else if (monthlyRate > 5) {
      const remaining = goal - total;
      const monthsNeeded = remaining / monthlyRate;
      const targetTime = new Date(Date.now() + monthsNeeded * 30.42 * 24 * 60 * 60 * 1000);
      etaText = new Intl.DateTimeFormat('es-ES', { month: 'short', year: 'numeric' }).format(targetTime);
      etaText = etaText.charAt(0).toUpperCase() + etaText.slice(1);
    } else {
      etaText = 'Poco a poco';
    }

    return { monthlyRate, etaText, avgDeposit };
  }

  function renderEntriesList(product) {
    const entriesNode = document.querySelector('#entries');
    const emptyNode = document.querySelector('#empty-state');
    entriesNode.innerHTML = '';

    const filtered = (product.entries || []).filter(item => {
      if (state.currentFilter === 'all') return true;
      return item.category === state.currentFilter;
    });

    emptyNode.hidden = filtered.length > 0;

    const sorted = [...filtered].sort((a, b) => {
      const dateA = String(a.date || '');
      const dateB = String(b.date || '');
      const cmp = dateB.localeCompare(dateA);
      if (cmp !== 0) return cmp;
      return (Number(b.created) || 0) - (Number(a.created) || 0);
    });

    sorted.forEach(item => {
      const date = safeDate(item.date);
      const isWithdraw = item.type === 'withdraw';
      const cat = CATEGORIES[item.category] || CATEGORIES.saving;

      const row = document.createElement('div');
      row.className = 'entry';

      const dateBox = document.createElement('div');
      dateBox.className = 'entry-date';
      const day = document.createElement('strong');
      day.textContent = String(date.getDate());
      const month = document.createElement('span');
      month.textContent = new Intl.DateTimeFormat('es-ES', { month: 'short' }).format(date).replace('.', '');
      dateBox.append(day, month);

      const desc = document.createElement('div');
      desc.className = 'entry-desc';
      const concept = document.createElement('div');
      concept.className = 'entry-concept';
      concept.textContent = item.concept;

      const meta = document.createElement('div');
      meta.className = 'entry-meta';
      const year = document.createElement('span');
      year.className = 'entry-year';
      year.textContent = String(date.getFullYear());
      const badge = document.createElement('span');
      badge.className = `badge-tag ${isWithdraw ? 'withdraw' : ''}`;
      badge.textContent = `${cat.icon} ${cat.label}`;

      meta.append(year, badge);
      desc.append(concept, meta);

      const amount = document.createElement('div');
      amount.className = `entry-amount ${isWithdraw ? 'is-negative' : ''}`;
      amount.textContent = `${isWithdraw ? '−' : '+'} ${euros(Number(item.amount))}`;

      const actions = document.createElement('div');
      actions.className = 'entry-actions';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'entry-btn';
      editBtn.innerHTML = '✎';
      editBtn.title = 'Editar';
      editBtn.addEventListener('click', () => openEditEntryModal(item));

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'entry-btn delete';
      deleteBtn.innerHTML = '×';
      deleteBtn.title = 'Eliminar';
      deleteBtn.addEventListener('click', async () => {
        const confirmed = await askConfirmation({
          title: `¿Eliminar "${item.concept}"?`,
          message: `Se eliminará este movimiento de ${euros(item.amount)}.`,
          okText: 'Eliminar movimiento'
        });
        if (confirmed) {
          // 1. Actualizar estado local inmediatamente para respuesta instantánea en pantalla
          const entryIdToDelete = item.id;
          product.entries = product.entries.filter(e => e.id !== entryIdToDelete);
          saveLocalData();
          renderDetail();

          // 2. Si tiene ID registrado en PocketBase, eliminar del servidor
          if (pb && entryIdToDelete && !entryIdToDelete.includes('-')) {
            try {
              await pb.collection('entries').delete(entryIdToDelete);
            } catch (err) {
              console.warn('Error borrando en PocketBase:', err);
            }
          }
        }
      });

      actions.append(editBtn, deleteBtn);
      row.append(dateBox, desc, amount, actions);
      entriesNode.append(row);
    });
  }

  // --- Formulario de Movimientos en Detalle ---
  const savingForm = document.querySelector('#saving-form');
  const dateInput = document.querySelector('#date');
  const typeBtns = document.querySelectorAll('.type-btn');
  const formTypeIcon = document.querySelector('#form-type-icon');
  const submitBtn = document.querySelector('#submit-btn');

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  dateInput.value = todayStr;

  typeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      typeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.formType = btn.dataset.type;

      if (state.formType === 'withdraw') {
        formTypeIcon.textContent = '−';
        formTypeIcon.classList.add('withdraw');
        submitBtn.innerHTML = 'Registrar retirada <span>↘</span>';
      } else {
        formTypeIcon.textContent = '+';
        formTypeIcon.classList.remove('withdraw');
        submitBtn.innerHTML = 'Añadir al ahorro <span>↗</span>';
      }
    });
  });

  savingForm.addEventListener('submit', async e => {
    e.preventDefault();
    const product = state.products.find(p => p.id === state.activeProductId);
    if (!product) return;

    const data = new FormData(savingForm);
    const amount = Number(data.get('amount'));
    const message = document.querySelector('#form-message');

    if (!Number.isFinite(amount) || amount <= 0) {
      message.textContent = 'Introduce un importe válido mayor que 0 €.';
      message.style.color = '#ef4444';
      return;
    }

    if (!Array.isArray(product.entries)) product.entries = [];

    const newEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      concept: String(data.get('concept')).trim(),
      amount,
      category: String(data.get('category')) || 'saving',
      type: state.formType,
      date: String(data.get('date')) || todayStr,
      created: Date.now()
    };

    // 1. Añadir inmediatamente a local y refrescar UI de forma instantánea
    product.entries.push(newEntry);

    // Si el usuario tenía un filtro activo que ocultaría la nueva entrada, restablecer a "all"
    if (state.currentFilter !== 'all' && state.currentFilter !== newEntry.category) {
      state.currentFilter = 'all';
      if (filterSelect) filterSelect.value = 'all';
    }

    saveLocalData();
    renderDetail();

    savingForm.reset();
    dateInput.value = todayStr;
    message.style.color = '#10b981';
    message.textContent = '✓ Movimiento guardado correctamente';
    setTimeout(() => {
      if (message.textContent.includes('guardado')) message.textContent = '';
    }, 3000);

    // 2. Guardar en PocketBase en segundo plano
    if (pb && state.user && product.id && !product.id.startsWith('prod-')) {
      try {
        const pbRecord = await pb.collection('entries').create({
          user: getUserId(),
          product: product.id,
          concept: newEntry.concept,
          amount: newEntry.amount,
          category: newEntry.category,
          type: newEntry.type,
          date: newEntry.date
        });
        // Actualizar el ID provisional con el asignado por PocketBase
        const targetEntry = product.entries.find(e => e.id === newEntry.id);
        if (targetEntry) {
          targetEntry.id = pbRecord.id;
        }
        newEntry.id = pbRecord.id;
        saveLocalData();
      } catch (err) {
        console.warn('Error guardando movimiento en PocketBase:', err);
        message.style.color = '#f59e0b';
        message.textContent = 'Guardado localmente (pendiente de sincronizar con servidor).';
      }
    }
  });

  // Filtro de Categoría
  const filterSelect = document.querySelector('#filter-category');
  filterSelect.addEventListener('change', e => {
    state.currentFilter = e.target.value;
    const product = state.products.find(p => p.id === state.activeProductId);
    if (product) renderEntriesList(product);
  });

  // Botón volver a Catálogo
  const btnBackToCatalog = document.querySelector('#btn-back-to-catalog');
  if (btnBackToCatalog) {
    btnBackToCatalog.addEventListener('click', e => {
      e.preventDefault();
      showCatalog();
    });
  }

  // Helpers para abrir/cerrar modales
  function openModal(modal) {
    if (!modal) return;
    modal.classList.add('is-open');
    modal.hidden = false;
    modal.style.display = 'flex';
  }

  function closeModal(modal) {
    if (!modal) return;
    modal.classList.remove('is-open');
    modal.hidden = true;
    modal.style.display = 'none';
  }

  // --- Modal: Crear / Editar Producto ---
  const productModal = document.querySelector('#product-modal');
  const productForm = document.querySelector('#product-form');
  const productIdInput = document.querySelector('#product-id');
  const productNameInput = document.querySelector('#product-name');
  const productGoalInput = document.querySelector('#product-goal');
  const productDateInput = document.querySelector('#product-date');
  const productImageVal = document.querySelector('#product-image-val');
  const productFileInput = document.querySelector('#product-file-input');
  const productImgError = document.querySelector('#product-img-error');
  const uploadDropzone = document.querySelector('#upload-dropzone');
  const dropzoneEmpty = document.querySelector('#dropzone-empty');
  const dropzonePreview = document.querySelector('#dropzone-preview');
  const previewImage = document.querySelector('#preview-image');
  const previewFilename = document.querySelector('#preview-filename');
  const btnChangeImage = document.querySelector('#btn-change-image');
  let selectedImageFile = null;

  document.querySelectorAll('#product-preset-chips .preset-chip').forEach(chip => {
    chip.addEventListener('click', e => {
      e.preventDefault();
      productGoalInput.value = chip.dataset.val;
    });
  });

  function handleImageFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      productImgError.textContent = 'Por favor selecciona un archivo de imagen válido (PNG, JPG, WEBP, SVG).';
      return;
    }
    selectedImageFile = file;
    const reader = new FileReader();
    reader.onload = evt => {
      productImageVal.value = evt.target.result;
      previewImage.src = evt.target.result;
      previewFilename.textContent = file.name || 'Foto del producto';
      dropzoneEmpty.hidden = true;
      dropzonePreview.hidden = false;
      uploadDropzone.classList.add('has-preview');
      productImgError.textContent = '';
    };
    reader.readAsDataURL(file);
  }

  if (productFileInput) {
    productFileInput.addEventListener('change', e => {
      if (e.target.files && e.target.files[0]) {
        handleImageFile(e.target.files[0]);
      }
      e.target.value = '';
    });
  }

  if (btnChangeImage && productFileInput) {
    btnChangeImage.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      productFileInput.click();
    });
  }

  if (uploadDropzone) {
    uploadDropzone.addEventListener('dragover', e => {
      e.preventDefault();
      uploadDropzone.classList.add('dragover');
    });

    uploadDropzone.addEventListener('dragleave', () => {
      uploadDropzone.classList.remove('dragover');
    });

    uploadDropzone.addEventListener('drop', e => {
      e.preventDefault();
      uploadDropzone.classList.remove('dragover');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleImageFile(e.dataTransfer.files[0]);
      }
    });
  }

  function openProductModal(existingProduct = null) {
    productImgError.textContent = '';
    selectedImageFile = null;
    if (existingProduct) {
      document.querySelector('#product-modal-title').textContent = 'Editar Producto de Ahorro';
      document.querySelector('#btn-save-product').textContent = 'Guardar cambios';
      productIdInput.value = existingProduct.id;
      productNameInput.value = existingProduct.name;
      productGoalInput.value = existingProduct.goal;
      productDateInput.value = existingProduct.targetDate || '';

      const currentImg = existingProduct.customImage || PRESETS[existingProduct.imagePreset]?.src || 'media/iPhone20.png';
      productImageVal.value = currentImg;
      previewImage.src = currentImg;
      previewFilename.textContent = existingProduct.name || 'Foto del producto';
      dropzoneEmpty.hidden = true;
      dropzonePreview.hidden = false;
      uploadDropzone.classList.add('has-preview');
    } else {
      document.querySelector('#product-modal-title').textContent = 'Nuevo Producto de Ahorro';
      document.querySelector('#btn-save-product').textContent = 'Crear producto';
      productForm.reset();
      productIdInput.value = '';
      productImageVal.value = '';
      previewImage.src = '';
      dropzoneEmpty.hidden = false;
      dropzonePreview.hidden = true;
      uploadDropzone.classList.remove('has-preview');
    }
    openModal(productModal);
  }

  const btnCreateProduct = document.querySelector('#btn-create-product');
  if (btnCreateProduct) {
    btnCreateProduct.addEventListener('click', e => {
      e.preventDefault();
      openProductModal();
    });
  }

  const btnEditCurrentProduct = document.querySelector('#btn-edit-current-product');
  if (btnEditCurrentProduct) {
    btnEditCurrentProduct.addEventListener('click', e => {
      e.preventDefault();
      const current = state.products.find(p => p.id === state.activeProductId);
      if (current) openProductModal(current);
    });
  }

  productForm.addEventListener('submit', async e => {
    e.preventDefault();
    const id = productIdInput.value;
    const name = productNameInput.value.trim();
    const goal = Number(productGoalInput.value);
    const date = productDateInput.value;
    const imgVal = productImageVal.value;

    if (!name || !Number.isFinite(goal) || goal <= 0) return;

    if (!imgVal && !selectedImageFile) {
      productImgError.textContent = 'Es obligatorio subir una foto para tu producto.';
      return;
    }

    if (id) {
      // Editar existente
      const product = state.products.find(p => p.id === id);
      if (product) {
        product.name = name;
        product.goal = goal;
        product.targetDate = date;
        if (imgVal) product.customImage = imgVal;

        if (pb && state.user && id && !id.startsWith('prod-')) {
          try {
            const formData = new FormData();
            formData.append('user', getUserId());
            formData.append('name', name);
            formData.append('goal', goal);
            formData.append('target_date', date || '');
            if (selectedImageFile) {
              formData.append('image', selectedImageFile);
            } else if (imgVal.startsWith('data:')) {
              formData.append('custom_image', imgVal);
            }
            const updated = await pb.collection('products').update(id, formData);
            if (updated.image) {
              product.customImage = pb.files.getURL(updated, updated.image);
            }
          } catch (err) {
            console.warn('Error actualizando en PocketBase:', err);
          }
        }
      }
    } else {
      // Crear nuevo
      const newProduct = {
        id: `prod-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name,
        goal,
        targetDate: date,
        customImage: imgVal,
        created: Date.now(),
        entries: []
      };

      if (pb && state.user) {
        try {
          const formData = new FormData();
          formData.append('user', getUserId());
          formData.append('name', name);
          formData.append('goal', goal);
          formData.append('target_date', date || '');
          if (selectedImageFile) {
            formData.append('image', selectedImageFile);
          } else if (imgVal) {
            formData.append('custom_image', imgVal);
          }
          const created = await pb.collection('products').create(formData);
          newProduct.id = created.id;
          if (created.image) {
            newProduct.customImage = pb.files.getURL(created, created.image);
          }
        } catch (err) {
          console.error('Error creando en PocketBase:', err);
          alert('Aviso al guardar en servidor: ' + (err?.data?.message || err?.message || 'Error desconocido'));
        }
      }

      state.products.push(newProduct);
    }

    saveLocalData();
    closeModal(productModal);

    if (state.activeProductId) {
      renderDetail();
    } else {
      renderCatalog();
    }
  });

  // --- Modal: Edición de Movimiento ---
  const editModal = document.querySelector('#edit-modal');
  const editForm = document.querySelector('#edit-form');
  const editId = document.querySelector('#edit-id');
  const editConcept = document.querySelector('#edit-concept');
  const editAmount = document.querySelector('#edit-amount');
  const editCategory = document.querySelector('#edit-category');
  const editDate = document.querySelector('#edit-date');

  function openEditEntryModal(entry) {
    editId.value = entry.id;
    editConcept.value = entry.concept;
    editAmount.value = entry.amount;
    editCategory.value = entry.category || 'saving';
    editDate.value = entry.date;
    openModal(editModal);
  }

  editForm.addEventListener('submit', async e => {
    e.preventDefault();
    const product = state.products.find(p => p.id === state.activeProductId);
    if (!product || !Array.isArray(product.entries)) return;

    const entry = product.entries.find(item => item.id === editId.value);
    if (!entry) return;

    entry.concept = editConcept.value.trim();
    entry.amount = Number(editAmount.value);
    entry.category = editCategory.value;
    entry.date = editDate.value;

    if (pb && state.user && entry.id && entry.id.length === 15) {
      try {
        await pb.collection('entries').update(entry.id, {
          user: getUserId(),
          concept: entry.concept,
          amount: entry.amount,
          category: entry.category,
          date: entry.date
        });
      } catch (err) {
        console.warn('Error actualizando movimiento en PocketBase:', err);
      }
    }

    saveLocalData();
    renderDetail();
    closeModal(editModal);
  });

  // --- Modal: Respaldo (Exportar / Importar) ---
  const backupModal = document.querySelector('#backup-modal');
  const btnOpenBackupCatalog = document.querySelector('#btn-open-backup-catalog');
  const btnOpenBackupDetail = document.querySelector('#btn-open-backup-detail');
  const btnOpenBackupFromUser = document.querySelector('#btn-open-backup-from-user');
  if (btnOpenBackupCatalog) {
    btnOpenBackupCatalog.addEventListener('click', e => {
      e.preventDefault();
      openModal(backupModal);
    });
  }
  if (btnOpenBackupDetail) {
    btnOpenBackupDetail.addEventListener('click', e => {
      e.preventDefault();
      openModal(backupModal);
    });
  }
  if (btnOpenBackupFromUser) {
    btnOpenBackupFromUser.addEventListener('click', e => {
      e.preventDefault();
      closeModal(userModal);
      openModal(backupModal);
    });
  }

  const btnExportJson = document.querySelector('#btn-export-json');
  if (btnExportJson) {
    btnExportJson.addEventListener('click', e => {
      e.preventDefault();
      const dataStr = JSON.stringify({
        version: 3,
        user: state.user?.email || 'local',
        exportDate: new Date().toISOString(),
        products: state.products
      }, null, 2);

      const blob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mis-metas-ahorro-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  const importInput = document.querySelector('#import-file-input');
  if (importInput) {
    importInput.addEventListener('change', event => {
      const file = event.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async e => {
        try {
          const imported = JSON.parse(e.target.result);
          if (Array.isArray(imported.products)) {
            state.products = imported.products;
            saveLocalData();
            if (pb && state.user) {
              await migrateLocalToPocketBase();
            }
            if (state.activeProductId) renderDetail();
            else renderCatalog();
            alert('¡Todas tus metas han sido restauradas correctamente!');
            closeModal(backupModal);
          } else {
            alert('El archivo no contiene un listado de productos válido.');
          }
        } catch (err) {
          alert('Archivo JSON no válido.');
        }
      };
      reader.readAsText(file);
      event.target.value = '';
    });
  }

  const btnResetAll = document.querySelector('#btn-reset-all');
  if (btnResetAll) {
    btnResetAll.addEventListener('click', async e => {
      e.preventDefault();
      if (confirm('¿Estás seguro de que quieres borrar TODAS tus metas de ahorro?')) {
        if (pb && state.user) {
          try {
            const pRecords = await pb.collection('products').getFullList({
              filter: `user = "${getUserId()}"`
            });
            for (const p of pRecords) {
              await pb.collection('products').delete(p.id);
            }
          } catch (err) {
            console.warn('Error vaciando PocketBase:', err);
          }
        }
        state.products = [];
        saveLocalData();
        showCatalog();
        closeModal(backupModal);
      }
    });
  }

  // --- Sistema de Autenticación y Gestión de Usuarios ---
  const loginModal = document.querySelector('#login-modal');
  const loginTitle = document.querySelector('#login-title');
  const authSubtitle = document.querySelector('#auth-subtitle');
  const loginForm = document.querySelector('#login-form');
  const loginEmail = document.querySelector('#login-email');
  const loginPassword = document.querySelector('#login-password');
  const loginError = document.querySelector('#login-error');
  const btnLoginSubmit = document.querySelector('#btn-login-submit');

  const registerForm = document.querySelector('#register-form');
  const registerName = document.querySelector('#register-name');
  const registerEmail = document.querySelector('#register-email');
  const registerPassword = document.querySelector('#register-password');
  const registerPasswordConfirm = document.querySelector('#register-password-confirm');
  const registerError = document.querySelector('#register-error');
  const btnRegisterSubmit = document.querySelector('#btn-register-submit');

  const btnGoToRegister = document.querySelector('#btn-go-to-register');
  const btnGoToLogin = document.querySelector('#btn-go-to-login');

  const userModal = document.querySelector('#user-modal');
  const userModalName = document.querySelector('#user-modal-name');
  const userModalEmail = document.querySelector('#user-modal-email');
  const btnLogout = document.querySelector('#btn-logout');
  const userEmailDisplay = document.querySelector('#user-email-display');
  const userEmailDisplayDetail = document.querySelector('#user-email-display-detail');

  // Alternar entre modo Login y modo Registro
  if (btnGoToRegister) {
    btnGoToRegister.addEventListener('click', () => {
      loginForm.hidden = true;
      registerForm.hidden = false;
      loginTitle.textContent = 'Crear Cuenta';
      authSubtitle.textContent = 'Crea tu usuario para empezar a guardar tus metas en tu nube privada.';
      loginError.textContent = '';
      registerError.textContent = '';
    });
  }

  if (btnGoToLogin) {
    btnGoToLogin.addEventListener('click', () => {
      registerForm.hidden = true;
      loginForm.hidden = false;
      loginTitle.textContent = 'Mis Metas de Ahorro';
      authSubtitle.textContent = 'Inicia sesión con tu cuenta de usuario para ver y gestionar tus propias metas.';
      loginError.textContent = '';
      registerError.textContent = '';
    });
  }

  function updateAuthUI() {
    if (state.user) {
      const displayName = state.user.name || state.user.email.split('@')[0];
      if (userEmailDisplay) userEmailDisplay.textContent = displayName;
      if (userEmailDisplayDetail) userEmailDisplayDetail.textContent = displayName;
      if (userModalName) userModalName.textContent = displayName;
      if (userModalEmail) userModalEmail.textContent = state.user.email;
      closeModal(loginModal);
    } else {
      if (userEmailDisplay) userEmailDisplay.textContent = 'Entrar';
      if (userEmailDisplayDetail) userEmailDisplayDetail.textContent = 'Entrar';
      openModal(loginModal);
    }
  }

  // Botones de sincronización manual
  document.querySelectorAll('#btn-sync-catalog, #btn-sync-detail').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      triggerManualSync(btn);
    });
  });

  // Re-sincronización automática al volver a la pestaña/app en iOS Safari
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.user) {
      triggerManualSync();
    }
  });
  window.addEventListener('focus', () => {
    if (state.user) {
      triggerManualSync();
    }
  });

  // Abrir modal de usuario
  document.querySelectorAll('#btn-user-profile, #btn-user-profile-detail').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      if (state.user) {
        openModal(userModal);
      } else {
        openModal(loginModal);
      }
    });
  });

  // Enviar formulario de Login
  if (loginForm) {
    loginForm.addEventListener('submit', async e => {
      e.preventDefault();
      loginError.textContent = '';
      const email = loginEmail.value.trim();
      const password = loginPassword.value;

      if (!email || !password) {
        loginError.textContent = 'Por favor introduce tu email y contraseña.';
        return;
      }

      try {
        btnLoginSubmit.disabled = true;
        btnLoginSubmit.innerHTML = '<span>Verificando...</span> ⏳';

        let authData = null;
        try {
          authData = await pb.collection('users').authWithPassword(email, password);
        } catch (e1) {
          // Si no es un usuario estándar, intentar autenticación de superuser
          try {
            authData = await pb.collection('_superusers').authWithPassword(email, password);
          } catch (e2) {
            throw e1;
          }
        }

        state.user = authData.record;
        // Si se autenticó como superuser, buscar su ID correspondiente en la colección 'users'
        if (state.user.collectionName === '_superusers') {
          try {
            const uRec = await pb.collection('users').getFirstListItem(`email = "${state.user.email}"`);
            state.user.usersId = uRec.id;
          } catch (_) {
            state.user.usersId = state.user.id;
          }
        } else {
          state.user.usersId = state.user.id;
        }
        updateAuthUI();

        // Cargar datos del usuario y sincronizar con PocketBase
        loadLocalData();
        await loadDataFromPocketBase();
        refreshCurrentView();
        subscribeRealtime();

        loginForm.reset();
      } catch (err) {
        console.error('Error de login:', err);
        const errMsg = err?.data?.message || err?.message || 'Error al conectar con el servidor';
        loginError.textContent = errMsg === 'Failed to authenticate.' ? 'Email o contraseña incorrectos.' : errMsg;
      } finally {
        btnLoginSubmit.disabled = false;
        btnLoginSubmit.innerHTML = '<span>Iniciar Sesión</span> ↗';
      }
    });
  }

  // Enviar formulario de Registro (Crear usuario nuevo en tabla 'users')
  if (registerForm) {
    registerForm.addEventListener('submit', async e => {
      e.preventDefault();
      registerError.textContent = '';

      const name = registerName.value.trim();
      const email = registerEmail.value.trim();
      const password = registerPassword.value;
      const passwordConfirm = registerPasswordConfirm.value;

      if (!email || !password) {
        registerError.textContent = 'El correo y la contraseña son obligatorios.';
        return;
      }

      if (password.length < 8) {
        registerError.textContent = 'La contraseña debe tener al menos 8 caracteres.';
        return;
      }

      if (password !== passwordConfirm) {
        registerError.textContent = 'Las contraseñas no coinciden.';
        return;
      }

      try {
        btnRegisterSubmit.disabled = true;
        btnRegisterSubmit.innerHTML = '<span>Creando cuenta...</span> ⏳';

        // 1. Crear nuevo registro en la tabla 'users'
        await pb.collection('users').create({
          email,
          password,
          passwordConfirm,
          name: name || email.split('@')[0]
        });

        // 2. Iniciar sesión automáticamente con el nuevo usuario
        const authData = await pb.collection('users').authWithPassword(email, password);
        state.user = authData.record;
        state.user.usersId = authData.record.id;

        updateAuthUI();

        // 3. Inicializar entorno para el nuevo usuario
        loadLocalData();
        await loadDataFromPocketBase();
        refreshCurrentView();
        subscribeRealtime();

        registerForm.reset();
      } catch (err) {
        console.error('Error de registro:', err);
        const errDetails = err?.data?.data;
        if (errDetails?.email) {
          registerError.textContent = 'Este correo electrónico ya está registrado o no es válido.';
        } else if (errDetails?.password) {
          registerError.textContent = 'La contraseña no cumple los requisitos (mínimo 8 caracteres).';
        } else {
          registerError.textContent = err?.data?.message || err?.message || 'Error al crear la cuenta.';
        }
      } finally {
        btnRegisterSubmit.disabled = false;
        btnRegisterSubmit.innerHTML = '<span>Crear Cuenta y Entrar</span> ↗';
      }
    });
  }

  // Cerrar sesión
  if (btnLogout) {
    btnLogout.addEventListener('click', () => {
      if (pb) pb.authStore.clear();
      state.user = null;
      state.products = [];
      closeModal(userModal);
      updateAuthUI();
      renderCatalog();
    });
  }

  // Cierre de Modales
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      const modal = document.querySelector(`#${btn.dataset.close}`);
      if (modal) closeModal(modal);
    });
  });

  document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
    backdrop.addEventListener('click', e => {
      // No permitir cerrar el modal de login tocando el fondo si no hay usuario autenticado
      if (backdrop === loginModal && !state.user) return;
      if (e.target === backdrop) closeModal(backdrop);
    });
  });

  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!state.user) return; // Forzar login si no está autenticado
      document.querySelectorAll('.modal-backdrop').forEach(m => closeModal(m));
    }
  });

  // --- Inicialización PWA ---
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js?v=1.13')
        .then(reg => {
          console.log('PWA lista, scope:', reg.scope);
          // Forzar comprobación inmediata de actualización del Service Worker
          if (reg.update) reg.update();
        })
        .catch(err => console.warn('Aviso Service Worker:', err));
    });
  }

  let deferredInstallPrompt = null;
  const installBtn = document.querySelector('#btn-install-catalog');

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (installBtn) installBtn.hidden = false;
  });

  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      if (!deferredInstallPrompt) {
        alert('Para instalar en tu móvil o tableta:\n1. Pulsa "Compartir" en tu navegador.\n2. Selecciona "Añadir a la pantalla de inicio".');
        return;
      }
      deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      if (choice && choice.outcome === 'accepted') {
        installBtn.hidden = true;
      }
      deferredInstallPrompt = null;
    });
  }

  // --- Inicialización Principal ---
  async function init() {
    // Comprobar si PocketBase ya tiene sesión guardada (Token válido)
    if (pb && pb.authStore.isValid && pb.authStore.record) {
      state.user = pb.authStore.record;
      if (state.user.collectionName === '_superusers') {
        try {
          const uRec = await pb.collection('users').getFirstListItem(`email = "${state.user.email}"`);
          state.user.usersId = uRec.id;
        } catch (_) {
          state.user.usersId = state.user.id;
        }
      } else {
        state.user.usersId = state.user.id;
      }
      updateAuthUI();

      loadLocalData();
      const initialHash = window.location.hash.replace('#', '');
      if (initialHash && state.products.some(p => p.id === initialHash)) {
        showDetail(initialHash);
      } else {
        showCatalog();
      }

      await loadDataFromPocketBase();
      refreshCurrentView();
      subscribeRealtime();
    } else {
      // Si no hay sesión, mostrar pantalla de Login
      updateAuthUI();
    }
  }

  init();
})();
