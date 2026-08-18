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
	install -Dm 755 bin/$(NAME) $(bindir)/$(NAME)
	 rsync -avz  --mkpath --delete $(BUILD_DIR) $(node_modulesdir)/$(BUILD_DIR)
	install -Dm 644 $(MAN) $(man1dir)/$(NAME).1
	install -Dm 644 $(LIC) $(licensdir)/LICENSE

uninstall:
	rm -f $(bindir)/$(NAME) \
		$(man1dir)/$(NAME).1
		$(licensdir)/LICENSE
	rmdir --ignore-fail-on-non-empty $(licensdir) $(docdir) $(node_modulesdir)

MKTEMP_TEMP := /tmp/edutoolsdist.XXX
clean:
	rm -rf $(BUILD_DIR)
	rm -rf $(subst XXX,*,$(MKTEMP_TEMP))
	rm -rf $(RPMBUILD_DIR)/{RPMS/x86_64,SOURCES,SPECS}/$(NAME)*

DIST_TAR_TMP_DIR = $(shell mktemp -d)
dist: release
	$(eval TEMP_DIR := $(shell mktemp -d $(MKTEMP_TEMP)))
	$(eval TAR_TEMP_DIR := $(TEMP_DIR)/$(NAMEVER))
	mkdir -p $(RPMBUILD_DIR)/{SPECS,SOURCES} \
		$(TAR_TEMP_DIR)

	# поместить в плоскую структуру файлы для архива
	cp -f bin/$(NAME) $(TAR_TEMP_DIR)/bin/
	cp -fr $(BUILD_DIR) $(TAR_TEMP_DIR)/
	cp -f LICENSE $(TAR_TEMP_DIR)/
	# cp -f $(NAME).1 $(TAR_TEMP_DIR)/
	cp -f Makefile $(TAR_TEMP_DIR)/

	# создать архив из временной плоской структуры
	tar -czf $(RPMBUILD_DIR)/SOURCES/$(NAMEVER).tar.gz \
		-C $(TEMP_DIR) $(NAMEVER)
	rm -rf $(TAR_TEMP_DIR)

	cp -u $(NAME).spec $(RPMBUILD_DIR)/SPECS/$(NAME).spec
