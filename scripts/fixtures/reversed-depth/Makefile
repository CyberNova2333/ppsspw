# SPDX-License-Identifier: AGPL-3.0-only
TARGET = reversed-depth
OBJS = main.o
CFLAGS = -O2 -Wall
LIBS = -lpspgu
EXTRA_CLEAN = reversed-depth.iso disc/PSP_GAME/SYSDIR/EBOOT.BIN disc/PSP_GAME/PARAM.SFO
PSPSDK := $(shell psp-config --pspsdk-path)
include $(PSPSDK)/lib/build.mak

# Boot the fixture through the same bounded disc reader as a game.
reversed-depth.iso: reversed-depth.elf
	mkdir -p disc/PSP_GAME/SYSDIR
	psp-strip -o disc/PSP_GAME/SYSDIR/EBOOT.BIN $<
	mksfoex -s CATEGORY=UG -s DISC_ID=TEST00001 "Reversed viewport depth" disc/PSP_GAME/PARAM.SFO
	genisoimage -quiet -iso-level 2 -V DEPTH_TEST -o $@ disc
