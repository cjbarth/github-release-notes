const babel = require("gulp-babel");
const chmod = require("gulp-chmod");
const gulp = require("gulp");

gulp.task("scripts", (done) => {
  gulp.src("./lib/src/**/*.js").pipe(babel()).pipe(gulp.dest("dist"));

  gulp.src("./lib/src/**/*.json").pipe(gulp.dest("dist"));

  gulp.src("./lib/*.js").pipe(babel()).pipe(chmod(0o755)).pipe(gulp.dest("bin"));

  done();
});

gulp.task("build", gulp.series(["scripts"]));
gulp.task("default", gulp.series(["build"]));
