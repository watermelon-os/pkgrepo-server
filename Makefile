NAME = watermelon-server
VERSION = 0.1
NAMEVER = $(NAME)-$(VERSION)

TOOL_DIR = tools/$(NAME)

RPMBUILD_DIR = .rpmbuild
BUILD_DIR = .build/$(NAME)
RELEASE_BIN = $(BUILD_DIR)/$(NAME)-release

include ../common/fhs.mk


# install не зависит от all: при сборке rpm бинарь уже в tar и пересборка не нужна.
install:
	install -d $(DESTDIR)$(bindir) $(DESTDIR)$(man1dir) $(DESTDIR)$(docdir) $(DESTDIR)$(licensdir)
	install -m 755 $(BIN) $(DESTDIR)$(bindir)/$(NAME)
	install -m 644 $(MAN) $(DESTDIR)$(man1dir)/$(NAME).1
	install -m 644 $(LIC) $(DESTDIR)$(licensdir)/LICENSE

uninstall:
	rm -f $(DESTDIR)$(bindir)/$(NAME)
	rm -f $(DESTDIR)$(man1dir)/$(NAME).1
	rm -f $(DESTDIR)$(licensdir)/LICENSE
	rmdir --ignore-fail-on-non-empty $(DESTDIR)$(licensdir) $(DESTDIR)$(docdir)

MKTEMP_TEMP := /tmp/edutoolsdist.XXX
clean:
	rm -rf $(BUILD_DIR)
	rm -rf $(subst XXX,*,$(MKTEMP_TEMP))
	rm -rf $(RPMBUILD_DIR)/{RPMS/x86_64,SOURCES,SPECS}/$(NAME)*