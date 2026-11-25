#!/bin/sh
# Installs the Archil desktop stack on Ubuntu (primary) or Debian. The
# Dockerfile runs this at build time; the launcher's --bootstrap path runs it
# inside a running sandbox. Expects rootfs/ to sit next to it.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
desktop_user=desktop
mozilla_key_fingerprint=35BAA0B33E9EB396F59CA838C0BA5CE6DC6315A3

. /etc/os-release
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg

# Ubuntu's firefox and chromium packages are snap wrappers, and snapd doesn't
# run in a sandbox, so take Firefox straight from Mozilla's APT repository.
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://packages.mozilla.org/apt/repo-signing-key.gpg -o /etc/apt/keyrings/packages.mozilla.org.asc
gpg --show-keys --with-colons /etc/apt/keyrings/packages.mozilla.org.asc |
  grep -q "^fpr:*$mozilla_key_fingerprint:" ||
  { echo "install.sh: Mozilla signing key fingerprint mismatch" >&2; exit 1; }
echo "deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main" \
  >/etc/apt/sources.list.d/mozilla.list
cat >/etc/apt/preferences.d/mozilla <<'PIN'
Package: *
Pin: origin packages.mozilla.org
Pin-Priority: 1000
PIN

# Xubuntu's theme, icons, and panel layout make XFCE look like a finished desktop.
distro_packages=
if [ "$ID" = ubuntu ]; then
  distro_packages="xubuntu-default-settings xfce4-whiskermenu-plugin xfce4-pulseaudio-plugin xfce4-indicator-plugin xfce4-notifyd"
fi

apt-get update
# shellcheck disable=SC2086
apt-get install -y --no-install-recommends \
  dbus-x11 \
  firefox \
  fonts-dejavu-core \
  fonts-liberation \
  fonts-noto-color-emoji \
  novnc \
  openssh-server \
  procps \
  python3-websockify \
  rsync \
  scrot \
  sudo \
  tigervnc-standalone-server \
  x11-xserver-utils \
  xauth \
  xdotool \
  xfce4 \
  xfce4-terminal \
  websockify \
  xdg-user-dirs \
  $distro_packages
apt-get clean
rm -rf /var/lib/apt/lists/*

# Host keys generated now would be shared by every sandbox made from this image;
# `archil sandbox ssh` creates each sandbox's own on first use.
rm -f /etc/ssh/ssh_host_*

if ! id "$desktop_user" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$desktop_user"
fi
echo "$desktop_user ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/90-archil-desktop
chmod 0440 /etc/sudoers.d/90-archil-desktop

cp -R "$here/rootfs/." /
chmod 0755 /usr/local/bin/desktopctl /usr/local/lib/archil-desktop/*

# Browsers send a Mac's Cmd key as Super, and often never send the key-up, so
# Super can stay held inside the desktop. Then "e" turns into Super+E and opens
# the file manager. Remove every Super binding, including Super alone (the
# Xubuntu menu key), so typing always types.
python3 - /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-keyboard-shortcuts.xml \
  /etc/xdg/xdg-xubuntu/xfce4/xfconf/xfce-perchannel-xml/xfce4-keyboard-shortcuts.xml <<'PY'
import os, sys
import xml.etree.ElementTree as ET
for path in sys.argv[1:]:
    if not os.path.exists(path):
        continue
    tree = ET.parse(path)
    for parent in tree.iter():
        for child in list(parent):
            if child.tag == "property" and "Super" in child.get("name", ""):
                parent.remove(child)
    tree.write(path, encoding="UTF-8", xml_declaration=True)
PY

# Start XFCE with its stock panel instead of the first-run "which panel?" dialog.
panel_default=/etc/xdg/xfce4/panel/default.xml
[ -e /etc/xdg/xdg-xubuntu/xfce4/panel/default.xml ] && panel_default=/etc/xdg/xdg-xubuntu/xfce4/panel/default.xml
panel_config=/home/$desktop_user/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml
if [ ! -e "$panel_config" ]; then
  mkdir -p "$(dirname "$panel_config")"
  cp "$panel_default" "$panel_config"
fi
# Drop panel plugins that aren't installed (e.g. Xubuntu's power manager, which
# a VM has no use for); otherwise the panel greets you with an error dialog.
python3 - "$panel_config" <<'PY'
import os, sys
import xml.etree.ElementTree as ET
path = sys.argv[1]
tree = ET.parse(path)
plugins = tree.getroot().find("property[@name='plugins']")
missing = set()
for plugin in list(plugins if plugins is not None else []):
    kind = plugin.get("value", "")
    if not os.path.exists(f"/usr/share/xfce4/panel/plugins/{kind}.desktop"):
        missing.add(plugin.get("name").removeprefix("plugin-"))
        plugins.remove(plugin)
for ids in tree.iter("property"):
    if ids.get("name") == "plugin-ids":
        for value in list(ids):
            if value.get("value") in missing:
                ids.remove(value)
tree.write(path, encoding="UTF-8", xml_declaration=True)
PY
chown -R "$desktop_user:$desktop_user" "/home/$desktop_user"
