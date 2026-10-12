# Builds a headless DOOM (doomgeneric) that streams raw RGB24 frames on fd 3.
#
# Engine sources come from the untracked vendor clone (see .gener/t0-findings.md §18):
#   git clone --depth 1 https://github.com/ozkl/doomgeneric .gener/vendor/doomgeneric
# Everything compiled here lands in .gener/build/doom (gitignored).
#
#   make -C scripts/doom -j8            -> .gener/build/doom/doom-headless
#   make -C scripts/doom clean
ENGINE ?= ../../.gener/vendor/doomgeneric/doomgeneric
BUILD  ?= ../../.gener/build/doom
CC     ?= gcc
RESX   ?= 320
RESY   ?= 200
BIN    := $(BUILD)/doom-headless

# Skipped upstream sources:
#  - the platform drivers (each brings its own main() + DG_* implementation)
#  - the backend-specific sound modules: they need SDL2/Allegro headers, and without
#    -DFEATURE_SOUND nothing in the engine calls them (same list as upstream Makefile).
SKIP := doomgeneric_win.c doomgeneric_xlib.c doomgeneric_sdl.c doomgeneric_allegro.c \
        doomgeneric_emscripten.c doomgeneric_soso.c doomgeneric_sosox.c doomgeneric_linuxvt.c \
        i_sdlsound.c i_sdlmusic.c i_allegrosound.c i_allegromusic.c

CFLAGS += -O2 -std=gnu99 -w -DNORMALUNIX -DLINUX -D_DEFAULT_SOURCE \
          -DDOOMGENERIC_RESX=$(RESX) -DDOOMGENERIC_RESY=$(RESY) -I$(ENGINE)
LDLIBS += -lm

ENGINE_SRCS := $(filter-out $(addprefix $(ENGINE)/,$(SKIP)), $(wildcard $(ENGINE)/*.c))
ENGINE_OBJS := $(patsubst $(ENGINE)/%.c,$(BUILD)/%.o,$(ENGINE_SRCS))
OBJS := $(ENGINE_OBJS) $(BUILD)/dg_stdio.o

all: $(BIN)

$(BUILD):
	@mkdir -p $(BUILD)

$(BUILD)/dg_stdio.o: dg_stdio.c | $(BUILD)
	@echo "[C] dg_stdio.c"
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD)/%.o: $(ENGINE)/%.c | $(BUILD)
	$(CC) $(CFLAGS) -c $< -o $@

$(BIN): $(OBJS)
	@echo "[LINK] $(BIN)"
	$(CC) -o $@ $(OBJS) $(LDLIBS)
	@ls -l $@

clean:
	rm -rf $(BUILD)

print:
	@echo "ENGINE=$(ENGINE)"
	@echo "SOURCES=$(words $(ENGINE_SRCS))"

.PHONY: all clean print
