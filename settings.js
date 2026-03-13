const iconStyle = document.getElementById('iconStyle');
const timeStyle = document.getElementById('timeStyle');
const launchAtLogin = document.getElementById('launchAtLogin');
const saveBtn = document.getElementById('saveBtn');
const cancelBtn = document.getElementById('cancelBtn');

const estimateTokens = document.getElementById('estimateTokens');
const sessionPlan = document.getElementById('sessionPlan');
const weeklyPlan = document.getElementById('weeklyPlan');

const appVersionLabel = document.getElementById('appVersionLabel');
const updateBtn = document.getElementById('updateBtn');
const updateStateLabel = document.getElementById('updateStateLabel');

window.onload = async () => {
    const settings = await electronAPI.getSettings();
    iconStyle.value = settings.iconStyle || 'rings';
    timeStyle.value = settings.timeStyle || 'absolute';
    launchAtLogin.checked = settings.launchAtLogin || false;

    estimateTokens.checked = settings.estimateTokens || false;
    sessionPlan.value = settings.sessionPlan || 44000;
    weeklyPlan.value = settings.weeklyPlan || 200000;

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
    } else if (updateState.state === 'available') {
        updateStateLabel.innerText = `Downloading v${updateState.version}...`;
    } else {
        updateStateLabel.innerText = 'Up to date';
    }
};

updateBtn.onclick = () => {
    electronAPI.installUpdate();
};

saveBtn.onclick = () => {
    const settings = {
        iconStyle: iconStyle.value,
        timeStyle: timeStyle.value,
        launchAtLogin: launchAtLogin.checked,
        estimateTokens: estimateTokens.checked,
        sessionPlan: parseInt(sessionPlan.value, 10),
        weeklyPlan: parseInt(weeklyPlan.value, 10)
    };
    electronAPI.saveSettings(settings);
    window.close();
};

cancelBtn.onclick = () => {
    window.close();
};
