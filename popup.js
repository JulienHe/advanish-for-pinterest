const DEFAULTS = {
  enabled: true,
  hideAds: true,
  hideSearchSuggestions: true,
  hideVideoPins: false,
  hideShoppablePins: false,
  keywords: [],
  gridEnabled: false,
  gridColumnCount: 0,
  gridGap: 16
};

const CHECKBOX_KEYS = ['enabled', 'hideAds', 'hideSearchSuggestions', 'hideVideoPins', 'hideShoppablePins', 'gridEnabled'];
const NUMBER_KEYS = ['gridColumnCount', 'gridGap'];

let state = { ...DEFAULTS };

function $(id) {
  return document.getElementById(id);
}

function render() {
  CHECKBOX_KEYS.forEach((key) => {
    $(key).checked = !!state[key];
  });
  NUMBER_KEYS.forEach((key) => {
    $(key).value = state[key];
  });
  renderKeywords();
}

function renderKeywords() {
  const list = $('keywordList');
  list.innerHTML = '';
  state.keywords.forEach((kw, idx) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = kw;
    const removeBtn = document.createElement('button');
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => {
      state.keywords.splice(idx, 1);
      persist();
      renderKeywords();
    });
    li.appendChild(span);
    li.appendChild(removeBtn);
    list.appendChild(li);
  });
}

function persist() {
  chrome.storage.sync.set(state);
}

function init() {
  chrome.storage.sync.get(DEFAULTS, (stored) => {
    state = { ...DEFAULTS, ...stored };
    render();
  });

  CHECKBOX_KEYS.forEach((key) => {
    $(key).addEventListener('change', (e) => {
      state[key] = e.target.checked;
      persist();
    });
  });

  NUMBER_KEYS.forEach((key) => {
    $(key).addEventListener('change', (e) => {
      state[key] = Number(e.target.value) || DEFAULTS[key];
      persist();
    });
  });

  $('addKeyword').addEventListener('click', addKeyword);
  $('keywordInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addKeyword();
  });
}

function addKeyword() {
  const input = $('keywordInput');
  const value = input.value.trim();
  if (!value) return;
  if (!state.keywords.includes(value)) {
    state.keywords.push(value);
    persist();
    renderKeywords();
  }
  input.value = '';
}

init();
