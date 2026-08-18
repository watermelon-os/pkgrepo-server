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

# BuildRequires: gcc
# BuildRequires: make
# BuildRequires: bash
Requires: /bin/bash /usr/bin/env node

# BuildArch: x86_64 aarch64
BuildArch: x86_64

# полное описание пакета
%description 
# нет

%prep
%setup # распаковатать архив в BUILD

%build
# tar.gz уже с подготовленным bin

%install
# %make_install = make install DESTDIR=%{buildroot}. prefix передаём явно,
# иначе Makefile по умолчанию поставит в /usr/local, а %files ждёт /usr.
%make_install prefix=%{_prefix} libdir=%{_libdir}

%files
%{_bindir}/%{name}
# %{_mandir}/man1/%{name}.1*
%license %{_licensedir}/%{name}/LICENSE
${_libdir}/node_modules/${name}