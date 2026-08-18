%{!?package_release: %global package_release 1}

Name: watermelon-server
# rpmbuld --define "package_version 1.2.3"
Version: %{package_version}
Release: %{package_release}

# краткое описание пакета
Summary: HTTP-сервер управления репозиториями системных пакетных менеджеров
License: MIT

URL: https://github.com/dsaime/linux-tools-edu/tree/master/tools/%{name}
Source: %{name}-%{version}.tar.gz

BuildRequires: npm
BuildRequires: make
BuildRequires: bash
Requires: /usr/bin/node

# BuildArch: x86_64 aarch64
BuildArch: x86_64

# полное описание пакета
%description
watermelon-server это HTTP-сервер (Node.js/Hono) с хранилищем SQLite
(Drizzle + better-sqlite3). Через REST API он управляет каталогом пакетов
и репозиториев, регистрирует версии, ставит задания на сборку и тест,
принимает обратные вызовы от раннеров и хранит логи и артефакты.

%prep
%setup # распаковатать архив в BUILD

%build
# tar.gz уже с подготовленным bin

%install
# %make_install = make install DESTDIR=%{buildroot}. prefix передаём явно,
# иначе Makefile по умолчанию поставит в /usr/local, а %files ждёт /usr.
# libdir НЕ передаём: node-модули архитектурно-независимы и в Fedora
# ставятся в /usr/lib/node_modules (как fhs.mk и %files ниже).
%make_install prefix=%{_prefix}

%files
%{_bindir}/%{name}
%{_prefix}/lib/node_modules/%{name}/
%license %{_licensedir}/%{name}/LICENSE