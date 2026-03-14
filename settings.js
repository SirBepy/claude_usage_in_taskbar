const displayMode = document.getElementById("displayMode");
const iconStyle = document.getElementById("iconStyle");
const timeStyle = document.getElementById("timeStyle");
const iconStyleSection = document.getElementById("iconStyleSection");
const timeStyleSection = document.getElementById("timeStyleSection");
const overlayDisplay = document.getElementById("overlayDisplay");
const overlayDisplaySection = document.getElementById("overlayDisplaySection");
const overlayStyle = document.getElementById("overlayStyle");
const overlayStyleSection = document.getElementById("overlayStyleSection");
const colorOverlayNumber = document.getElementById("colorOverlayNumber");
const colorOverlayNumberSection = document.getElementById(
  "colorOverlayNumberSection",
);
const launchAtLogin = document.getElementById("launchAtLogin");
const refreshUpdateBtn = document.getElementById("refreshUpdateBtn");
const saveBtn = document.getElementById("saveBtn");
const cancelBtn = document.getElementById("cancelBtn");
const copyLogsBtn = document.getElementById("copyLogsBtn");

const estimateTokens = document.getElementById("estimateTokens");
const sessionPlan = document.getElementById("sessionPlan");
const weeklyPlan = document.getElementById("weeklyPlan");

const appVersionLabel = document.getElementById("appVersionLabel");
const updateBtn = document.getElementById("updateBtn");
const updateStateLabel = document.getElementById("updateStateLabel");
const colorContainer = document.getElementById("colorContainer");
const addColorBtn = document.getElementById("addColorBtn");

function createColorRow(min = 0, color = "#ffffff") {
  const row = document.createElement("div");
  row.className = "option";
  row.style.marginBottom = "8px";
  row.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px; flex: 1;">
            <input type="number" class="color-min" value="${min}" min="0" max="100" style="width: 50px; background:#2a2a2a; color:var(--text); border:1px solid var(--border); padding:4px; border-radius:4px;">
            <span style="font-size: 0.8rem; color: var(--text-dim);">%</span>
            <input type="color" class="color-val" value="${color}" style="width: 30px; height: 24px; border: none; background: none; cursor: pointer;">
        </div>
        <button class="btn-secondary remove-color-btn" style="padding: 2px 8px; font-size: 0.7rem;">Remove</button>
    `;

  row.querySelector(".remove-color-btn").onclick = () => {
    row.remove();
  };

  return row;
}

window.onload = async () => {
  const settings = await electronAPI.getSettings();
  displayMode.value = settings.displayMode || "both";
  iconStyle.value = settings.iconStyle || "rings";
  timeStyle.value = settings.timeStyle || "absolute";
  overlayDisplay.value = settings.overlayDisplay || "none";
  overlayStyle.value = settings.overlayStyle || "classic";
  colorOverlayNumber.checked = settings.colorOverlayNumber !== false;
  launchAtLogin.checked = settings.launchAtLogin || false;

  updateVisibilities();

  estimateTokens.checked = settings.estimateTokens || false;
  sessionPlan.value = settings.sessionPlan || 44000;
  weeklyPlan.value = settings.weeklyPlan || 200000;

  const thresholds = settings.colorThresholds || [];
  thresholds.forEach((t) =>
    colorContainer.appendChild(createColorRow(t.min, t.color)),
  );

  addColorBtn.onclick = () =>
    colorContainer.appendChild(createColorRow(0, "#4a90e2"));

  const toggleInputs = () => {
    sessionPlan.disabled = !estimateTokens.checked;
    weeklyPlan.disabled = !estimateTokens.checked;
  };
  estimateTokens.addEventListener("change", toggleInputs);
  toggleInputs();

  const version = await electronAPI.getAppVersion();
  appVersionLabel.innerText = `Version: ${version}`;

  function renderUpdateState(updateState) {
    if (updateState.state === "downloaded") {
      updateStateLabel.innerText = "Update ready to install";
      updateStateLabel.style.color = "var(--primary)";
      updateBtn.style.display = "block";
      updateBtn.disabled = false;
      updateBtn.innerText = `Install v${updateState.version}`;
      updateBtn.onclick = () => electronAPI.installUpdate();
    } else if (updateState.state === "available") {
      updateStateLabel.innerText = `New version available: v${updateState.version}`;
      updateStateLabel.style.color = "var(--text)";
      updateBtn.style.display = "block";
      updateBtn.disabled = false;
      updateBtn.innerText = "Download & Update";
      updateBtn.onclick = () => {
        updateBtn.disabled = true;
        updateBtn.innerText = "Downloading...";
        electronAPI.downloadUpdate();
      };
    } else if (updateState.state === "downloading") {
      updateStateLabel.innerText = "Downloading update...";
      updateStateLabel.style.color = "var(--text-dim)";
      updateBtn.style.display = "none";
    } else if (updateState.state === "error") {
      updateStateLabel.innerText = `Update error: ${updateState.version}`;
      updateStateLabel.style.color = "#ff4444";
      updateBtn.style.display = "block";
      updateBtn.disabled = false;
      updateBtn.innerText = "Retry Check";
      updateBtn.onclick = () => electronAPI.checkForUpdates();
    } else {
      updateStateLabel.innerText = "Up to date";
      updateStateLabel.style.color = "var(--text-dim)";
      updateBtn.style.display = "none";
    }
  }

  const initialState = await electronAPI.getUpdateState();
  renderUpdateState(initialState);

  electronAPI.onUpdateStateChange((state) => {
    console.log("Update state changed:", state);
    renderUpdateState(state);
  });
};

saveBtn.onclick = () => {
  const settings = {
    iconStyle: iconStyle.value,
    timeStyle: timeStyle.value,
    displayMode: displayMode.value,
    overlayDisplay: overlayDisplay.value,
    overlayStyle: overlayStyle.value,
    colorOverlayNumber: colorOverlayNumber.checked,
    launchAtLogin: launchAtLogin.checked,
    estimateTokens: estimateTokens.checked,
    sessionPlan: parseInt(sessionPlan.value, 10),
    weeklyPlan: parseInt(weeklyPlan.value, 10),
    colorThresholds: Array.from(colorContainer.querySelectorAll(".option"))
      .map((row) => ({
        min: parseInt(row.querySelector(".color-min").value, 10),
        color: row.querySelector(".color-val").value,
      }))
      .sort((a, b) => a.min - b.min),
  };
  electronAPI.saveSettings(settings);
  window.close();
};

cancelBtn.onclick = () => {
  window.close();
};

function updateVisibilities() {
  const mode = displayMode.value;

  // Icon related fields
  if (mode === "number") {
    iconStyleSection.style.display = "none";
    timeStyleSection.style.display = "none";
  } else {
    iconStyleSection.style.display = "flex";
    timeStyleSection.style.display = "flex";
  }

  // Number related fields
  if (mode === "icon") {
    overlayDisplaySection.style.display = "none";
    overlayStyleSection.style.display = "none";
    colorOverlayNumberSection.style.display = "none";
  } else {
    overlayDisplaySection.style.display = "flex";
    overlayStyleSection.style.display = "flex";
    colorOverlayNumberSection.style.display = "flex";
  }
}

displayMode.addEventListener("change", updateVisibilities);

refreshUpdateBtn.addEventListener("click", () => {
  console.log("Manual update check triggered");
  electronAPI.checkForUpdates();
  
  updateStateLabel.innerText = "Checking for updates...";
  updateStateLabel.style.color = "var(--text-dim)";
  updateBtn.style.display = "none";

  const updateStatus = document.getElementById("updateStatus");
  const updateInfo = document.getElementById("updateInfo");
  if (updateStatus) updateStatus.textContent = "Checking for updates...";
  if (updateInfo) updateInfo.style.display = "block";

  // Hide the "Checking..." info after 5 seconds
  setTimeout(() => {
    if (updateInfo) updateInfo.style.display = "none";
  }, 5000);
});

copyLogsBtn.addEventListener("click", () => {
  electronAPI.copyLogs();
  const originalText = copyLogsBtn.textContent;
  copyLogsBtn.textContent = "Copied to Clipboard!";
  copyLogsBtn.classList.replace("btn-secondary", "btn-primary");

  setTimeout(() => {
    copyLogsBtn.textContent = originalText;
    copyLogsBtn.classList.replace("btn-primary", "btn-secondary");
  }, 2000);
});
