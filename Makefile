.PHONY: all install uninstall clean dist rpm release

NAME = watermelon-server
VERSION = 0.1
NAMEVER = $(NAME)-$(VERSION)

TOOL_DIR = tools/$(NAME)

RPMBUILD_DIR = .rpmbuild
BUILD_DIR = dist

include ../common/fhs.mk

release:
	npm run build

install: release
	ln -s $(DESTDIR)$(node_modulesdir)/bin/$(NAME) $(DESTDIR)$(bindir)/$(NAME)
	install -Dm 755 bin/$(NAME) $(DESTDIR)$(node_modulesdir)/bin/$(NAME)
	rsync -avz  --mkpath --delete $(BUILD_DIR) $(DESTDIR)$(node_modulesdir)/$(BUILD_DIR)
	install -Dm 644 $(MAN) $(DESTDIR)$(man1dir)/$(NAME).1
	install -Dm 644 $(LIC) $(DESTDIR)$(licensdir)/LICENSE

uninstall:
	rm -f $(DESTDIR)$(bindir)/$(NAME) \
		$(DESTDIR)$(man1dir)/$(NAME).1
		$(DESTDIR)$(licensdir)/LICENSE
	rmdir --ignore-fail-on-non-empty $(DESTDIR)$(licensdir) $(DESTDIR)$(docdir) $(DESTDIR)$(node_modulesdir)

MKTEMP_TEMP := /tmp/edutoolsdist.XXX
clean:
	rm -rf $(BUILD_DIR)
	rm -rf $(subst XXX,*,$(MKTEMP_TEMP))
	rm -rf $(RPMBUILD_DIR)/{RPMS/x86_64,SOURCES,SPECS}/$(NAME)*

DIST_TAR_TMP_DIR = $(shell mktemp -d)
dist: release
	mkdir -p $(RPMBUILD_DIR)/{SPECS,SOURCES}
	cat ../common/fhs.mk Makefile > Makefile.tmp
	# sed -i '/include ..\/common\/fhs.mk/d' Makefile.tmp
	sed -i '\|include ../common/fhs.mk|d' Makefile.tmp
	tar -czf $(RPMBUILD_DIR)/SOURCES/$(NAMEVER).tar.gz \
		--transform 's|^Makefile.tmp$$|Makefile|' \
		--transform 's|^|$(NAMEVER)/|' \
		bin/$(NAME) $(BUILD_DIR) LICENSE Makefile.tmp

	rm -f Makefile.tmp
	cp -u $(NAME).spec $(RPMBUILD_DIR)/SPECS/$(NAME).spec

rpm: dist
	rpmbuild -bb $(RPMBUILD_DIR)/SPECS/$(NAME).spec \
		--define "package_version $(VERSION)" \
		--define "_topdir $(CURDIR)/$(RPMBUILD_DIR)"
	rpm --addsign $(RPMBUILD_DIR)/RPMS/*/$(NAMEVER)*.rpm