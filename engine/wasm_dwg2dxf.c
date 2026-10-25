/* wasm_dwg2dxf.c - thin WebAssembly entry point around GNU LibreDWG.
 *
 * Copyright (C) 2026  dwg2dxf-pwa contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.  See ../LICENSE.
 *
 * Exposes one function, w_convert(), which does what programs/dwg2dxf.c
 * does (dwg_read_file + dwg_write_dxf) and additionally writes a JSON
 * summary of what LibreDWG decoded, so the UI can compare the DWG side
 * against the produced DXF and warn about skipped or unsupported data.
 * All I/O goes through the Emscripten in-memory filesystem; nothing
 * leaves the device.
 */

#include "config.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>

#include <dwg.h>
#include <dwg_api.h>
#include "common.h"
#include "bits.h"
#include "classes.h"
#include "out_dxf.h"

#ifdef __EMSCRIPTEN__
#  include <emscripten.h>
#  define WEXPORT EMSCRIPTEN_KEEPALIVE
#else
#  define WEXPORT
#endif

/* ---- tiny growable JSON writer ---------------------------------------- */

typedef struct
{
  char *p;
  size_t len, cap;
} sbuf;

static void
sb_grow (sbuf *b, size_t need)
{
  if (b->len + need + 1 <= b->cap)
    return;
  size_t cap = b->cap ? b->cap : 4096;
  while (cap < b->len + need + 1)
    cap *= 2;
  b->p = (char *)realloc (b->p, cap);
  b->cap = cap;
}

static void
sb_puts (sbuf *b, const char *s)
{
  size_t n = strlen (s);
  sb_grow (b, n);
  memcpy (b->p + b->len, s, n + 1);
  b->len += n;
}

static void
sb_printf (sbuf *b, const char *fmt, ...)
{
  char tmp[512];
  va_list ap;
  va_start (ap, fmt);
  vsnprintf (tmp, sizeof (tmp), fmt, ap);
  va_end (ap);
  sb_puts (b, tmp);
}

/* JSON string. Input is expected to be UTF-8; invalid bytes are passed
   through as \u00XX so the JSON stays parseable. */
static void
sb_str (sbuf *b, const char *s)
{
  sb_grow (b, 2);
  b->p[b->len++] = '"';
  if (s)
    for (const unsigned char *c = (const unsigned char *)s; *c; c++)
      {
        sb_grow (b, 6);
        switch (*c)
          {
          case '"':
            sb_puts (b, "\\\"");
            break;
          case '\\':
            sb_puts (b, "\\\\");
            break;
          case '\n':
            sb_puts (b, "\\n");
            break;
          case '\r':
            sb_puts (b, "\\r");
            break;
          case '\t':
            sb_puts (b, "\\t");
            break;
          default:
            if (*c < 0x20)
              sb_printf (b, "\\u%04x", *c);
            else
              b->p[b->len++] = (char)*c;
          }
      }
  b->p[b->len++] = '"';
  b->p[b->len] = 0;
}

/* A string field as UTF-8. dynapi converts r2007+ (UTF-16) strings itself
   but returns older ones in the drawing's code page, so convert those. */
static void
sb_utf8_field (sbuf *b, const Dwg_Data *dwg, void *_obj, const char *objname,
               const char *field)
{
  char *text = NULL;
  int isnew = 0;
  if (_obj && dwg_dynapi_entity_utf8text (_obj, objname, field, &text, &isnew,
                                          NULL))
    {
      if (text && !isnew && !IS_FROM_TU_DWG (dwg) && dwg->header.codepage)
        {
          char *u8 = bit_TV_to_utf8 (text, dwg->header.codepage);
          sb_str (b, u8 ? u8 : text);
          if (u8 && u8 != text)
            free (u8);
        }
      else
        sb_str (b, text);
      if (isnew && text)
        free (text);
    }
  else
    sb_puts (b, "null");
}

/* ---- per-type counters ------------------------------------------------- */

typedef struct
{
  char name[64];
  char dxfname[64];
  int entity;
  int stability; /* 0 stable 1 unstable 2 debugging 3 unhandled 4 unknown */
  unsigned count;
} tcount;

static tcount *types;
static unsigned ntypes, captypes;

static int
stability_of (const Dwg_Object *obj)
{
  if (obj->fixedtype == DWG_TYPE_UNKNOWN_ENT
      || obj->fixedtype == DWG_TYPE_UNKNOWN_OBJ)
    return 4;
  if (is_type_stable (obj->fixedtype))
    return 0;
  if (is_type_unstable (obj->fixedtype))
    return 1;
  if (is_type_debugging (obj->fixedtype))
    return 2;
  if (is_type_unhandled (obj->fixedtype))
    return 3;
  return 0;
}

static void
count_type (const Dwg_Object *obj)
{
  const char *name = obj->name ? obj->name : "?";
  const char *dxf = obj->dxfname ? obj->dxfname : name;
  for (unsigned i = 0; i < ntypes; i++)
    if (!strcmp (types[i].name, name) && !strcmp (types[i].dxfname, dxf))
      {
        types[i].count++;
        return;
      }
  if (ntypes == captypes)
    {
      captypes = captypes ? captypes * 2 : 64;
      types = (tcount *)realloc (types, captypes * sizeof (tcount));
    }
  tcount *t = &types[ntypes++];
  memset (t, 0, sizeof (*t));
  snprintf (t->name, sizeof (t->name), "%s", name);
  snprintf (t->dxfname, sizeof (t->dxfname), "%s", dxf);
  t->entity = obj->supertype == DWG_SUPERTYPE_ENTITY;
  t->stability = stability_of (obj);
  t->count = 1;
}

/* ---- summary ----------------------------------------------------------- */

static void
pt3 (sbuf *b, const char *key, BITCODE_3BD p)
{
  sb_printf (b, "\"%s\":[%.17g,%.17g,%.17g]", key, p.x, p.y, p.z);
}

/* Describe what was decoded. Must run right after dwg_read_file, before the
   header version is changed for --as, because string decoding depends on
   it. Returns the JSON object members without the surrounding braces. */
static char *
collect_summary (Dwg_Data *dwg, int read_err)
{
  sbuf b = { 0 };
  Dwg_Header_Variables *hv = &dwg->header_vars;
  unsigned max_texts = 20000;
  ntypes = 0;

  sb_printf (&b, "\"libredwg\":\"%s\",", PACKAGE_VERSION);
  sb_printf (&b, "\"read_error\":%d,", read_err);
  sb_puts (&b, "\"dwg_version\":");
  sb_str (&b, dwg_version_type (dwg->header.from_version));
  sb_printf (&b, ",\"codepage\":%u", (unsigned)dwg->header.codepage);
  sb_printf (&b, ",\"num_objects\":%u,\"num_classes\":%u",
             (unsigned)dwg->num_objects, (unsigned)dwg->num_classes);
  sb_printf (&b, ",\"header\":{\"INSUNITS\":%u,\"MEASUREMENT\":%u,"
                 "\"LUNITS\":%u,",
             (unsigned)hv->INSUNITS, (unsigned)hv->MEASUREMENT,
             (unsigned)hv->LUNITS);
  pt3 (&b, "EXTMIN", hv->EXTMIN);
  sb_puts (&b, ",");
  pt3 (&b, "EXTMAX", hv->EXTMAX);
  sb_puts (&b, "}");

  /* classes */
  sb_puts (&b, ",\"classes\":[");
  for (unsigned i = 0; i < dwg->num_classes; i++)
    {
      Dwg_Class *k = &dwg->dwg_class[i];
      const char *st = !k->dxfname           ? "?"
                       : is_class_stable (k->dxfname)    ? "stable"
                       : is_class_unstable (k->dxfname)  ? "unstable"
                       : is_class_debugging (k->dxfname) ? "debugging"
                       : is_class_unhandled (k->dxfname) ? "unhandled"
                                                          : "unknown";
      if (i)
        sb_puts (&b, ",");
      sb_puts (&b, "{\"dxfname\":");
      sb_str (&b, k->dxfname);
      sb_printf (&b, ",\"entity\":%d,\"status\":\"%s\",\"proxyflag\":%u}",
                 dwg_class_is_entity (k) ? 1 : 0, st,
                 (unsigned)k->proxyflag);
    }
  sb_puts (&b, "]");

  /* walk objects */
  sb_puts (&b, ",\"layers\":[");
  int first_layer = 1;
  sbuf blocks = { 0 }, images = { 0 }, texts = { 0 };
  int first_block = 1, first_image = 1, first_text = 1;
  unsigned ntexts = 0;
  sb_puts (&blocks, "");
  sb_puts (&images, "");
  sb_puts (&texts, "");
  for (unsigned i = 0; i < dwg->num_objects; i++)
    {
      Dwg_Object *obj = &dwg->object[i];
      if (obj->fixedtype == DWG_TYPE_FREED || obj->fixedtype == DWG_TYPE_UNUSED)
        continue;
      count_type (obj);
      switch (obj->fixedtype)
        {
        case DWG_TYPE_LAYER:
          if (!first_layer)
            sb_puts (&b, ",");
          first_layer = 0;
          sb_utf8_field (&b, dwg, obj->tio.object->tio.LAYER, "LAYER", "name");
          break;
        case DWG_TYPE_BLOCK_HEADER:
          {
            Dwg_Object_BLOCK_HEADER *_o = obj->tio.object->tio.BLOCK_HEADER;
            if (!first_block)
              sb_puts (&blocks, ",");
            first_block = 0;
            sb_puts (&blocks, "{\"name\":");
            sb_utf8_field (&blocks, dwg, _o, "BLOCK_HEADER", "name");
            sb_printf (&blocks, ",\"xref\":%d,\"overlay\":%d,\"anonymous\":%d",
                       _o->blkisxref ? 1 : 0, _o->xrefoverlaid ? 1 : 0,
                       _o->anonymous ? 1 : 0);
            if (_o->blkisxref || _o->xrefoverlaid)
              {
                sb_puts (&blocks, ",\"path\":");
                sb_utf8_field (&blocks, dwg, _o, "BLOCK_HEADER", "xref_pname");
              }
            sb_puts (&blocks, "}");
          }
          break;
        case DWG_TYPE_IMAGEDEF:
          if (!first_image)
            sb_puts (&images, ",");
          first_image = 0;
          sb_utf8_field (&images, dwg, obj->tio.object->tio.IMAGEDEF, "IMAGEDEF",
                         "file_path");
          break;
        case DWG_TYPE_TEXT:
        case DWG_TYPE_ATTRIB:
        case DWG_TYPE_ATTDEF:
        case DWG_TYPE_MTEXT:
        case DWG_TYPE_TOLERANCE:
          if (ntexts < max_texts)
            {
              const char *field = obj->fixedtype == DWG_TYPE_MTEXT ? "text"
                                  : obj->fixedtype == DWG_TYPE_ATTDEF
                                      ? "default_value"
                                      : "text_value";
              if (!first_text)
                sb_puts (&texts, ",");
              first_text = 0;
              sb_puts (&texts, "[");
              sb_str (&texts, obj->name);
              sb_puts (&texts, ",");
              sb_utf8_field (&texts, dwg, obj->tio.entity->tio.TEXT, obj->name,
                             field);
              sb_puts (&texts, "]");
              /* attribute tags identify the attribute; check them too */
              if (obj->fixedtype == DWG_TYPE_ATTRIB
                  || obj->fixedtype == DWG_TYPE_ATTDEF)
                {
                  sb_printf (&texts, ",[\"%s_TAG\",", obj->name);
                  sb_utf8_field (&texts, dwg, obj->tio.entity->tio.TEXT,
                                 obj->name, "tag");
                  sb_puts (&texts, "]");
                }
            }
          ntexts++;
          break;
        default:
          break;
        }
    }
  sb_puts (&b, "],\"blocks\":[");
  sb_puts (&b, blocks.p);
  sb_puts (&b, "],\"images\":[");
  sb_puts (&b, images.p);
  sb_printf (&b, "],\"texts_total\":%u,\"texts\":[", ntexts);
  sb_puts (&b, texts.p);
  sb_puts (&b, "],\"types\":[");
  for (unsigned i = 0; i < ntypes; i++)
    {
      static const char *stab[]
          = { "stable", "unstable", "debugging", "unhandled", "unknown" };
      if (i)
        sb_puts (&b, ",");
      sb_puts (&b, "{\"name\":");
      sb_str (&b, types[i].name);
      sb_puts (&b, ",\"dxfname\":");
      sb_str (&b, types[i].dxfname);
      sb_printf (&b, ",\"entity\":%d,\"status\":\"%s\",\"count\":%u}",
                 types[i].entity, stab[types[i].stability], types[i].count);
    }
  sb_puts (&b, "]");
  free (blocks.p);
  free (images.p);
  free (texts.p);
  return b.p;
}

static void
write_summary (const char *path, const char *body, const Dwg_Data *dwg,
               int write_err, const char *as_version)
{
  sbuf b = { 0 };
  sb_printf (&b, "{\"write_error\":%d,\"dxf_version\":", write_err);
  sb_str (&b, dwg_version_type (dwg->header.version));
  sb_puts (&b, ",\"as_version\":");
  sb_str (&b, as_version ? as_version : "");
  sb_puts (&b, ",");
  sb_puts (&b, body ? body : "\"read_error\":-1");
  sb_puts (&b, "}");
  FILE *fh = fopen (path, "wb");
  if (fh)
    {
      fwrite (b.p, 1, b.len, fh);
      fclose (fh);
    }
  free (b.p);
}

/* Convert in_path (DWG) to out_path (DXF) and write summary_path (JSON).
   as_version: "" keeps the DWG's version, else e.g. "r2000", "r2018".
   loglevel: LibreDWG log level (warnings/errors go to stderr).
   Returns the LibreDWG error bitmask (>= 128 is critical). */
WEXPORT int
w_convert (const char *in_path, const char *out_path,
           const char *summary_path, const char *as_version, int loglevel)
{
  Dwg_Data dwg;
  Bit_Chain dat = { 0 };
  int read_err, write_err = 0;
  char *body;

  memset (&dwg, 0, sizeof (dwg));
  dwg.opts = loglevel & DWG_OPTS_LOGLEVEL;
  read_err = dwg_read_file (in_path, &dwg);
  body = collect_summary (&dwg, read_err);
  if (read_err >= DWG_ERR_CRITICAL)
    {
      write_summary (summary_path, body, &dwg, 0, as_version);
      free (body);
      dwg_free (&dwg);
      return read_err;
    }

  if (as_version && *as_version)
    {
      Dwg_Version_Type v = dwg_version_as (as_version);
      if (v == R_INVALID)
        {
          write_summary (summary_path, body, &dwg, DWG_ERR_INTERNALERROR,
                         as_version);
          free (body);
          dwg_free (&dwg);
          return read_err | DWG_ERR_INTERNALERROR;
        }
      if (dwg.header.from_version != dwg.header.version)
        dwg.header.from_version = dwg.header.version;
      dwg.header.version = v;
    }
  dat.version = dwg.header.version;
  dat.from_version = dwg.header.from_version;
  dat.fh = fopen (out_path, "wb");
  if (!dat.fh)
    write_err = DWG_ERR_IOERROR;
  else
    {
      write_err = dwg_write_dxf (&dat, &dwg);
      fclose (dat.fh);
    }

  write_summary (summary_path, body, &dwg, write_err, as_version);
  free (body);
  dwg_free (&dwg);
  return read_err | write_err;
}

#ifndef __EMSCRIPTEN__
int
main (int argc, char **argv)
{
  if (argc < 4)
    {
      fprintf (stderr, "usage: %s in.dwg out.dxf summary.json [rNNNN]\n",
               argv[0]);
      return 2;
    }
  return w_convert (argv[1], argv[2], argv[3], argc > 4 ? argv[4] : "", 1)
                 >= DWG_ERR_CRITICAL
             ? 1
             : 0;
}
#endif
