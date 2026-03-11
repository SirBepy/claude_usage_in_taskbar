const iconStyle = document.getElementById('iconStyle');
const timeStyle = document.getElementById('timeStyle');
const launchAtLogin = document.getElementById('launchAtLogin');
const saveBtn = document.getElementById('saveBtn');
const cancelBtn = document.getElementById('cancelBtn');

const appVersionLabel = document.getElementById('appVersionLabel');
const updateBtn = document.getElementById('updateBtn');
const updateStateLabel = document.getElementById('updateStateLabel');

window.onload = async () => {
    const settings = await electronAPI.getSettings();
    iconStyle.value = settings.iconStyle || 'rings';
    timeStyle.value = settings.timeStyle || 'absolute';
    launchAtLogin.checked = settings.launchAtLogin || false;

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
        launchAtLogin: launchAtLogin.checked
    };
    electronAPI.saveSettings(settings);
    window.close();
};

cancelBtn.onclick = () => {
    window.close();
};
