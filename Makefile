.PHONY: all install uninstall clean dist rpm release

NAME = watermelon-server
VERSION = 0.1
NAMEVER = $(NAME)-$(VERSION)

TOOL_DIR = tools/$(NAME)

RPMBUILD_DIR = .rpmbuild
BUILD_DIR = dist

# Внутри распакованного tar (rpmbuild) файлы лежат плоско в cwd, в дереве исходников —
# тоже в cwd (server не компилируется, bin/dist уже готовы). $(wildcard) берёт то, что есть.
LIC := $(or $(wildcard LICENSE),LICENSE)

# Блок GNU-переменных установки (стандарт autoconf/GNU make, они же — соглашения FHS).
# Мотивация: пользователь/сборщик пакета может переопределить любую из них стандартным
# способом (make install prefix=/usr), не читая Makefile. Иерархия производных друг от
# друга (exec_prefix<-prefix, bindir<-exec_prefix, ...) повторяет общепринятую схему.
# ВАЖНО: комментарии пишем только на отдельных строках — inline-комментарий после значения
# make вырезает, но оставляет пробелы перед ним, и пути ломаются («/usr/local   /bin»).
# prefix — корень установки по умолчанию.
prefix      = /usr/local
# exec_prefix — = prefix, если нет особой раскладки архитектурно-зависимых файлов.
exec_prefix = $(prefix)

# DESTDIR — здесь не объявляется (это не наша переменная), а передаётся извне.
# Мотивация: стандартный механизм staging-установки — устанавливать не в корень ФС,
# а в $DESTDIR<путь>, чтобы потом упаковать в rpm/deb/т.п. без прав root.

# bindir — исполняемые файлы.
bindir      = $(exec_prefix)/bin
# datarootdir — архитектурно-независимые данные.
datarootdir = $(prefix)/share
# libdir — архитектурно-зависимые библиотеки.
libdir      = $(exec_prefix)/lib
# sysconfdir — системные конфигурационные файлы.
sysconfdir = $(prefix)/etc
# srvdir — данные, предоставляемые системой по сети.
srvdir = $(prefix)/srv
# localstatedir — изменяемые данные системы.
localstatedir = $(prefix)/var
# unitdir юниты systemd
unitdir = $(prefix)/lib/systemd/system

# docdir — документация именно этой утилиты.
docdir      = $(datarootdir)/doc/$(NAME)
# licensdir — лицензия (соглашение Fedora: /usr/share/licenses/<name>).
licensdir   = $(datarootdir)/licenses/$(NAME)
# node_modulesdir — системный каталог Node.js-пакетов.
node_modulesdir = $(libdir)/node_modules/$(NAME)

# repodir — репозитории пакетов.
repodir = $(srvdir)/repo

release:
	npm ci
	npm run build
	npm prune --omit=dev

# install не пересобирает (dist уже в tar от make dist): в rpmbuild нет package.json.
install:
	mkdir -p $(DESTDIR)$(bindir)
	ln -s $(node_modulesdir)/bin/$(NAME).js $(DESTDIR)$(bindir)/$(NAME)
	install -Dm 755 bin/$(NAME).js $(DESTDIR)$(node_modulesdir)/bin/$(NAME).js
	install -Dm 644 package.json $(DESTDIR)$(node_modulesdir)/package.json
	rsync -avz --mkpath --delete node_modules/ $(DESTDIR)$(node_modulesdir)/node_modules
	rsync -avz --mkpath --delete $(BUILD_DIR)/ $(DESTDIR)$(node_modulesdir)/$(BUILD_DIR)
	rsync -avz --mkpath drizzle/ $(DESTDIR)$(node_modulesdir)/drizzle
	install -Dm 644 $(LIC) $(DESTDIR)$(licensdir)/LICENSE
	install -Dm 600 .env.example $(DESTDIR)$(sysconfdir)/sysconfig/$(NAME)
	install -d $(DESTDIR)$(repodir) $(DESTDIR)$(localstatedir)/lib/$(NAME)
	install -Dm 644 $(NAME).service $(DESTDIR)$(unitdir)/$(NAME).service

uninstall:
	rm -f $(DESTDIR)$(bindir)/$(NAME) \
		$(DESTDIR)$(node_modulesdir) \
		$(DESTDIR)$(licensdir)/LICENSE \
		$(DESTDIR)$(unitdir)/$(NAME).service
	rmdir --ignore-fail-on-non-empty $(DESTDIR)$(licensdir) \
		$(DESTDIR)$(docdir) \
		$(DESTDIR)$(node_modulesdir) \
		$(DESTDIR)$(repodir) \
		$(DESTDIR)$(localstatedir)/lib/$(NAME)

clean:
	rm -rf $(BUILD_DIR) $(RPMBUILD_DIR)

DIST_TAR_TMP_DIR = $(shell mktemp -d)
dist: release
	mkdir -p $(RPMBUILD_DIR)/{SPECS,SOURCES}
	tar -czf $(RPMBUILD_DIR)/SOURCES/$(NAMEVER).tar.gz \
		--transform 's|^|$(NAMEVER)/|' \
		bin/$(NAME).js $(BUILD_DIR) node_modules drizzle LICENSE Makefile package.json .env.example $(NAME).service
	rm -f Makefile.tmp
	cp -u $(NAME).spec $(RPMBUILD_DIR)/SPECS/$(NAME).spec

rpm: dist
	rpmbuild -bb $(RPMBUILD_DIR)/SPECS/$(NAME).spec \
		--define "package_version $(VERSION)" \
		--define "_topdir $(CURDIR)/$(RPMBUILD_DIR)"
	rpm --addsign $(RPMBUILD_DIR)/RPMS/*/$(NAMEVER)*.rpm

print:
	@echo $(DESTDIR)$(bindir)/$(NAME)
	@echo $(DESTDIR)$(sysconfdir)/sysconfig/$(NAME)