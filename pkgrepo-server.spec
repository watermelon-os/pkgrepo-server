%global srvdir /srv

Name: pkgrepo-server
Version: 0.1.1
Release: 1
Summary: HTTP-сервер управления репозиториями системных пакетных менеджеров
License: MIT
URL: https://github.com/watermelon-os/pkgrepo-server
Source0: https://github.com/watermelon-os/%{name}/archive/v%{version}.tar.gz
# Source0: https://github.com/watermelon-os/pkgrepo-server/archive/v0.1.tar.gz

BuildRequires: nodejs24
BuildRequires: nodejs24-devel
BuildRequires: gcc
BuildRequires: make
BuildRequires: python3
Requires: /usr/bin/node
Requires: systemd
# Requires: (createrepo_c or createrepo)
# Requires: dpkg-dev
# Requires: pacman
Suggests: rpm
Suggests: dpkg
Suggests: tar


# BuildArch: x86_64 aarch64
BuildArch: x86_64

# полное описание пакета
%description
pkgrepo-server это HTTP-сервер (Node.js/Hono) с хранилищем SQLite
(Drizzle + better-sqlite3). Через REST API он управляет каталогом пакетов
и репозиториев, регистрирует версии, ставит задания на сборку и тест,
принимает обратные вызовы от раннеров и хранит логи и артефакты.

%prep
%setup # распаковатать архив в BUILD

%build
make release

%install
# %make_install = make install DESTDIR=%{buildroot}. prefix передаём явно,
# иначе Makefile по умолчанию поставит в /usr/local, а %files ждёт /usr.
# libdir НЕ передаём: node-модули архитектурно-независимы и в Fedora
# ставятся в /usr/lib/node_modules (как fhs.mk и %files ниже).
%make_install prefix=%{_prefix} \
    exec_prefix=%{_exec_prefix} \
    libdir=%{_libdir} \
    sysconfdir=%{_sysconfdir} \
    localstatedir=%{_localstatedir} \
    srvdir=%{srvdir}
# Удалить ELF которые генерируют зависимости от прочих архитектур
# Оставить только native addon для целевой Linux-платформы.
%define sqlite_prebuilds %{buildroot}%{_libdir}/node_modules/%{name}/node_modules/better-sqlite3/prebuilds
find %{sqlite_prebuilds} -type f ! -name 'linux-x64.node' -delete

%files
%config(noreplace) %{_sysconfdir}/sysconfig/%{name}
%{_bindir}/%{name}
%{_libdir}/node_modules/%{name}/
%license %{_defaultlicensedir}/%{name}/LICENSE
%dir %{_localstatedir}/lib/%{name}
%dir %{srvdir}/repo
%{_unitdir}/%{name}.service