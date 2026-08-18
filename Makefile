NAME = watermelon-server
VERSION = 0.1
NAMEVER = $(NAME)-$(VERSION)

TOOL_DIR = tools/$(NAME)

RPMBUILD_DIR = .rpmbuild
BUILD_DIR = .build/$(NAME)
RELEASE_BIN = $(BUILD_DIR)/$(NAME)-release

include ../common/fhs.mk

release:
	npm run build

# install не зависит от all: при сборке rpm бинарь уже в tar и пересборка не нужна.
install:
	install -d $(datarootdir)$(NAME) \
		$(man1dir) \
		$(bindir) \
		$(node_modulesdir) \
		$(licensdir)
	install 
	install -m 644 $(BIN) $(datarootdir)/$(NAME)
	install -m 644 $(MAN) $(man1dir)/$(NAME).1
	install -m 644 $(LIC) $(licensdir)/LICENSE

uninstall:
	rm -f $(bindir)/$(NAME)
	rm -f $(man1dir)/$(NAME).1
	rm -f $(licensdir)/LICENSE
	rmdir --ignore-fail-on-non-empty $(licensdir) $(docdir)

MKTEMP_TEMP := /tmp/edutoolsdist.XXX
clean:
	rm -rf $(BUILD_DIR)
	rm -rf $(subst XXX,*,$(MKTEMP_TEMP))
	rm -rf $(RPMBUILD_DIR)/{RPMS/x86_64,SOURCES,SPECS}/$(NAME)*