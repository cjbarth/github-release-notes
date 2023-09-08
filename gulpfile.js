const babel = require("gulp-babel");
const chmod = require("gulp-chmod");
const eslint = require("gulp-eslint");
const prettier = require("gulp-prettier");
const gulp = require("gulp");

gulp.task("scripts", (done) => {
  gulp.src("./lib/src/**/*.js").pipe(babel()).pipe(gulp.dest("dist"));

  gulp.src("./lib/src/**/*.json").pipe(gulp.dest("dist"));

  gulp.src("./lib/*.js").pipe(babel()).pipe(chmod(0o755)).pipe(gulp.dest("bin"));

  done();
});

gulp.task("lint", () =>
  gulp
    .src("./lib/**/*.js")
    .pipe(
      eslint({
        fix: true,
      }),
    )
    .pipe(eslint.format())
    .pipe(prettier())
    .pipe(gulp.dest("./lib/")),
);

gulp.task("watch", () => gulp.watch("./lib/**/*.js", gulp.series(["lint", "scripts"])));

gulp.task("build", gulp.series(["lint", "scripts"]));
gulp.task("default", gulp.series(["build", "watch"]));
