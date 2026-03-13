const iconStyle = document.getElementById('iconStyle');
const timeStyle = document.getElementById('timeStyle');
const overlayDisplay = document.getElementById('overlayDisplay');
const overlayStyle = document.getElementById('overlayStyle');
const cleanNumberMode = document.getElementById('cleanNumberMode');
const launchAtLogin = document.getElementById('launchAtLogin');
const saveBtn = document.getElementById('saveBtn');
const cancelBtn = document.getElementById('cancelBtn');

const estimateTokens = document.getElementById('estimateTokens');
const sessionPlan = document.getElementById('sessionPlan');
const weeklyPlan = document.getElementById('weeklyPlan');

const appVersionLabel = document.getElementById('appVersionLabel');
const updateBtn = document.getElementById('updateBtn');
const updateStateLabel = document.getElementById('updateStateLabel');
const colorContainer = document.getElementById('colorContainer');
const addColorBtn = document.getElementById('addColorBtn');

function createColorRow(min = 0, color = '#ffffff') {
    const row = document.createElement('div');
    row.className = 'option';
    row.style.marginBottom = '8px';
    row.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px; flex: 1;">
            <input type="number" class="color-min" value="${min}" min="0" max="100" style="width: 50px; background:#2a2a2a; color:var(--text); border:1px solid var(--border); padding:4px; border-radius:4px;">
            <span style="font-size: 0.8rem; color: var(--text-dim);">%</span>
            <input type="color" class="color-val" value="${color}" style="width: 30px; height: 24px; border: none; background: none; cursor: pointer;">
        </div>
        <button class="btn-secondary remove-color-btn" style="padding: 2px 8px; font-size: 0.7rem;">Remove</button>
    `;
    
    row.querySelector('.remove-color-btn').onclick = () => {
        row.remove();
    };
    
    return row;
}

window.onload = async () => {
    const settings = await electronAPI.getSettings();
    iconStyle.value = settings.iconStyle || 'rings';
    timeStyle.value = settings.timeStyle || 'absolute';
    overlayDisplay.value = settings.overlayDisplay || 'none';
    overlayStyle.value = settings.overlayStyle || 'classic';
    cleanNumberMode.checked = settings.cleanNumberMode || false;
    launchAtLogin.checked = settings.launchAtLogin || false;

    estimateTokens.checked = settings.estimateTokens || false;
    sessionPlan.value = settings.sessionPlan || 44000;
    weeklyPlan.value = settings.weeklyPlan || 200000;

    const thresholds = settings.colorThresholds || [];
    thresholds.forEach(t => colorContainer.appendChild(createColorRow(t.min, t.color)));

    addColorBtn.onclick = () => colorContainer.appendChild(createColorRow(0, '#4a90e2'));

    const toggleInputs = () => {
        sessionPlan.disabled = !estimateTokens.checked;
        weeklyPlan.disabled = !estimateTokens.checked;
    };
    estimateTokens.addEventListener('change', toggleInputs);
    toggleInputs();

    const version = await electronAPI.getAppVersion();
    appVersionLabel.innerText = `Version: ${version}`;

    const updateState = await electronAPI.getUpdateState();
    if (updateState.state === 'downloaded') {
        updateStateLabel.innerText = 'Update ready to install';
        updateBtn.style.display = 'block';
        updateBtn.innerText = `Install v${updateState.version}`;
        updateBtn.onclick = () => electronAPI.installUpdate();
    } else if (updateState.state === 'available') {
        updateStateLabel.innerText = `New version available: v${updateState.version}`;
        updateBtn.style.display = 'block';
        updateBtn.innerText = 'Download & Update';
        updateBtn.onclick = () => {
            updateBtn.disabled = true;
            updateBtn.innerText = 'Downloading...';
            electronAPI.downloadUpdate();
        };
    } else if (updateState.state === 'downloading') {
        updateStateLabel.innerText = 'Downloading update...';
        updateBtn.style.display = 'none';
    } else {
        updateStateLabel.innerText = 'Up to date';
        updateBtn.style.display = 'none';
    }
};

updateBtn.onclick = () => {
    // This is handled dynamically above
};

saveBtn.onclick = () => {
    const settings = {
        iconStyle: iconStyle.value,
        timeStyle: timeStyle.value,
        overlayDisplay: overlayDisplay.value,
        overlayStyle: overlayStyle.value,
        cleanNumberMode: cleanNumberMode.checked,
        launchAtLogin: launchAtLogin.checked,
        estimateTokens: estimateTokens.checked,
        sessionPlan: parseInt(sessionPlan.value, 10),
        weeklyPlan: parseInt(weeklyPlan.value, 10),
        colorThresholds: Array.from(colorContainer.querySelectorAll('.option')).map(row => ({
            min: parseInt(row.querySelector('.color-min').value, 10),
            color: row.querySelector('.color-val').value
        })).sort((a, b) => a.min - b.min)
    };
    electronAPI.saveSettings(settings);
    window.close();
};

cancelBtn.onclick = () => {
    window.close();
};
