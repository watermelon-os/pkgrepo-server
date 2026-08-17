NAME = watermelon-server
VERSION = 0.1
NAMEVER = $(NAME)-$(VERSION)

TOOL_DIR = tools/$(NAME)

RPMBUILD_DIR = .rpmbuild


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
# bindir — исполняемые файлы.
bindir      = $(exec_prefix)/bin
# datarootdir — архитектурно-независимые данные.
datarootdir = $(prefix)/share
# mandir — man-страницы.
mandir      = $(datarootdir)/man
# man1dir — man-страницы раздела 1 (команды).
man1dir     = $(mandir)/man1
# docdir — документация именно этой утилиты.
docdir      = $(datarootdir)/doc/$(NAME)
# licensdir — лицензия (соглашение Fedora: /usr/share/licenses/<name>).
licensdir   = $(datarootdir)/licenses/$(NAME)

# DESTDIR — не объявляется здесь (это не наша переменная), а передаётся извне.
# Мотивация: стандартный механизм staging-установки — устанавливать не в корень ФС,
# а в $DESTDIR<путь>, чтобы потом упаковать в rpm/deb/т.п. без прав root.
# Работает из-за того, что в правилах install пути написаны как $(DESTDIR)$(bindir) и т.д.
