function ComputeNumChunks(length) {
  // Determine the number of chunks of size CHUNK_SIZE;
  // note that the final chunk may be smaller than CHUNK_SIZE.
  var chunks = length >>> CHUNK_SHIFT;
  if (chunks << CHUNK_SHIFT === length)
    return chunks;
  return chunks + 1;
}

function ComputeSliceBounds(numItems, sliceIndex, numSlices) {
  // Computes the bounds for slice |sliceIndex| of |numItems| items,
  // assuming |numSlices| total slices.  If numItems is not evenly
  // divisible by numSlices, then the final thread may have a bit of
  // extra work.  It might be better to do the division more
  // equitably.
  var sliceWidth = (numItems / numSlices) | 0;
  var startIndex = sliceWidth * sliceIndex;
  var endIndex = sliceIndex === numSlices - 1 ? numItems : sliceWidth * (sliceIndex + 1);
  return [startIndex, endIndex];
}

function ComputeAllSliceBounds(numItems, numSlices) {
  // Divides |numItems| items amongst |numSlices| slices.  The result
  // is an array containing multiple values per slice: the start
  // index, end index, current position, and some padding.  The
  // current position is initally the same as the start index.  To
  // access the values for a particular slice, use the macros
  // SLICE_START() and so forth.

  var info = [];
  for (var i = 0; i < numSlices; i++) {
    var [start, end] = ComputeSliceBounds(numItems, i, numSlices);
    info.push(SLICE_INFO(start, end));
  }
  return info;
}

function ComputeProducts(shape) {
  // Compute the partial products in reverse order.
  // e.g., if the shape is [A,B,C,D], then the
  // array |products| will be [1,D,CD,BCD].
  var product = 1;
  var products = [1];
  var sdimensionality = shape.length;
  for (var i = sdimensionality - 1; i > 0; i--) {
    product *= shape[i];
    products.push(product);
  }
  return products;
}

function ComputeIndices(shape, index1d) {
  // Given a shape and some index |index1d|, computes and returns an
  // array containing the N-dimensional index that maps to |index1d|.

  var products = ComputeProducts(shape);
  var l = shape.length;

  var result = [];
  for (var i = 0; i < l; i++) {
    // Obtain product of all higher dimensions.
    // So if i == 0 and shape is [A,B,C,D], yields BCD.
    var stride = products[l - i - 1];

    // Compute how many steps of width stride we could take.
    var index = (index1d / stride) | 0;
    result[i] = index;

    // Adjust remaining indices for smaller dimensions.
    index1d -= (index * stride);
  }

  return result;
}

function StepIndices(shape, indices) {
  for (var i = shape.length - 1; i >= 0; i--) {
    var indexi = indices[i] + 1;
    if (indexi < shape[i]) {
      indices[i] = indexi;
      return;
    }
    indices[i] = 0;
  }
}

function IsInteger(v) {
  return (v | 0) === v;
}

// Constructor
//
// We split the 3 construction cases so that we don't case on arguments.

function ParallelArrayConstruct0() {
  this.buffer = [];
  this.offset = 0;
  this.shape = [0];
  this.get = ParallelArrayGet1;
}

function ParallelArrayConstruct1(buffer) {
  var buffer = ToObject(buffer);
  var length = buffer.length >>> 0;
  if (length !== buffer.length)
    ThrowError(JSMSG_PAR_ARRAY_BAD_ARG, "");

  var buffer1 = [];
  for (var i = 0; i < length; i++)
    buffer1[i] = buffer[i];

  this.buffer = buffer1;
  this.offset = 0;
  this.shape = [length];
  this.get = ParallelArrayGet1;
}

function ParallelArrayConstruct2(shape, func) {
  if (typeof shape === "number") {
    var length = shape >>> 0;
    if (length !== shape)
      ThrowError(JSMSG_PAR_ARRAY_BAD_ARG, "");
    ParallelArrayBuild(this, [length], func);
  } else {
    var shape1 = [];
    for (var i = 0, l = shape.length; i < l; i++) {
      var s0 = shape[i];
      var s1 = s0 >>> 0;
      if (s1 !== s0)
        ThrowError(JSMSG_PAR_ARRAY_BAD_ARG, "");
      shape1[i] = s1;
    }
    ParallelArrayBuild(this, shape1, func);
  }
}

// We duplicate code here to avoid extra cloning.
function ParallelArrayConstruct3(shape, func, mode) {
  if (typeof shape === "number") {
    var length = shape >>> 0;
    if (length !== shape)
      ThrowError(JSMSG_PAR_ARRAY_BAD_ARG, "");
    ParallelArrayBuild(this, [length], func, mode);
  } else {
    var shape1 = [];
    for (var i = 0, l = shape.length; i < l; i++) {
      var s0 = shape[i];
      var s1 = s0 >>> 0;
      if (s1 !== s0)
        ThrowError(JSMSG_PAR_ARRAY_BAD_ARG, "");
      shape1[i] = s1;
    }
    ParallelArrayBuild(this, shape1, func, mode);
  }
}

function ParallelArrayView(shape, buffer, offset) {
  this.shape = shape;
  this.buffer = buffer;
  this.offset = offset;

  switch (shape.length) {
    case 1: this.get = ParallelArrayGet1; break;
    case 2: this.get = ParallelArrayGet2; break;
    case 3: this.get = ParallelArrayGet3; break;
    default: this.get = ParallelArrayGetN; break;
  }

  // Due to inlining of NewParallelArray, the return type of this function
  // gets recorded as the return type of NewParallelArray at inlined sites, so
  // we must take care to return the same thing.
  return this;
}

function ParallelArrayBuild(self, shape, func, mode) {
  self.offset = 0;
  self.shape = shape;

  var length;
  var xDimension, yDimension, zDimension;
  var computefunc;

  switch (shape.length) {
  case 1:
    length = shape[0];
    self.get = ParallelArrayGet1;
    computefunc = fill1;
    break;
  case 2:
    xDimension = shape[0];
    yDimension = shape[1];
    length = xDimension * yDimension;
    self.get = ParallelArrayGet2;
    computefunc = fill2;
    break;
  case 3:
    xDimension = shape[0];
    yDimension = shape[1];
    zDimension = shape[2];
    length = xDimension * yDimension * zDimension;
    self.get = ParallelArrayGet3;
    computefunc = fill3;
    break;
  default:
    length = 1;
    for (var i = 0; i < shape.length; i++)
      length *= shape[i];
    self.get = ParallelArrayGetN;
    computefunc = fillN;
    break;
  }

  var buffer = self.buffer = NewDenseArray(length);

  parallel: for (;;) {
    // Avoid parallel compilation if we are already nested in another
    // parallel section or the user told us not to parallelize.  The
    // use of a for (;;) loop is working around some ion limitations:
    //
    // - Breaking out of named blocks does not currently work (bug 684384);
    // - Unreachable Code Elim. can't properly handle if (a && b) (bug 669796)
    if (ForceSequential())
      break parallel;
    if (!TRY_PARALLEL(mode))
      break parallel;
    if (computefunc === fillN)
      break parallel;

    var chunks = ComputeNumChunks(length);
    var numSlices = ParallelSlices();
    var info = ComputeAllSliceBounds(chunks, numSlices);
    ParallelDo(constructSlice, CheckParallel(mode));
    return;
  }

  // Sequential fallback:
  CHECK_SEQUENTIAL(mode);
  computefunc(0, length);
  return;

  function constructSlice(sliceId, numSlices, warmup) {
    var chunkPos = info[SLICE_POS(sliceId)];
    var chunkEnd = info[SLICE_END(sliceId)];

    if (warmup && chunkEnd > chunkPos)
      chunkEnd = chunkPos + 1;

    while (chunkPos < chunkEnd) {
      var indexStart = chunkPos << CHUNK_SHIFT;
      var indexEnd = std_Math_min(indexStart + CHUNK_SIZE, length);
      computefunc(indexStart, indexEnd);
      UnsafeSetElement(info, SLICE_POS(sliceId), ++chunkPos);
    }
  }

  function fill1(indexStart, indexEnd) {
    for (var i = indexStart; i < indexEnd; i++)
      UnsafeSetElement(buffer, i, func(i));
  }

  function fill2(indexStart, indexEnd) {
    var x = (indexStart / yDimension) | 0;
    var y = indexStart - x*yDimension;
    for (var i = indexStart; i < indexEnd; i++) {
      UnsafeSetElement(buffer, i, func(x, y));
      if (++y == yDimension) {
        y = 0;
        ++x;
      }
    }
  }

  function fill3(indexStart, indexEnd) {
    var x = (indexStart / (yDimension*zDimension)) | 0;
    var r = indexStart - x*yDimension*zDimension;
    var y = (r / zDimension) | 0;
    var z = r - y*zDimension;
    for (var i = indexStart; i < indexEnd; i++) {
      UnsafeSetElement(buffer, i, func(x, y, z));
      if (++z == zDimension) {
        z = 0;
        if (++y == yDimension) {
          y = 0;
          ++x;
        }
      }
    }
  }

  function fillN(indexStart, indexEnd) {
    var indices = ComputeIndices(shape, indexStart);
    for (var i = indexStart; i < indexEnd; i++) {
      UnsafeSetElement(buffer, i, func.apply(null, indices));
      StepIndices(shape, indices);
    }
  }
}

function ParallelArrayMap(func, mode) {
  var self = this;
  var length = self.shape[0];
  var buffer = NewDenseArray(length);

  parallel: for (;;) { // see ParallelArrayBuild() to explain why for(;;) etc

    if (ForceSequential())
      break parallel;
    if (!TRY_PARALLEL(mode))
      break parallel;

    var chunks = ComputeNumChunks(length);
    var numSlices = ParallelSlices();
    var info = ComputeAllSliceBounds(chunks, numSlices);
    ParallelDo(mapSlice, CheckParallel(mode));
    return NewParallelArray(ParallelArrayView, [length], buffer, 0);
  }

  // Sequential fallback:
  CHECK_SEQUENTIAL(mode);
  for (var i = 0; i < length; i++)
    buffer[i] = func(self.get(i), i, self);
  return NewParallelArray(ParallelArrayView, [length], buffer, 0);

  function mapSlice(sliceId, numSlices, warmup) {
    var chunkPos = info[SLICE_POS(sliceId)];
    var chunkEnd = info[SLICE_END(sliceId)];

    if (warmup && chunkEnd > chunkPos)
      chunkEnd = chunkPos + 1;

    while (chunkPos < chunkEnd) {
      var indexStart = chunkPos << CHUNK_SHIFT;
      var indexEnd = std_Math_min(indexStart + CHUNK_SIZE, length);

      for (var i = indexStart; i < indexEnd; i++)
        UnsafeSetElement(buffer, i, func(self.get(i), i, self));

      UnsafeSetElement(info, SLICE_POS(sliceId), ++chunkPos);
    }
  }
}

function ParallelArrayReduce(func, mode) {
  var self = this;
  var length = self.shape[0];

  if (length === 0)
    ThrowError(JSMSG_PAR_ARRAY_REDUCE_EMPTY);

  parallel: for (;;) { // see ParallelArrayBuild() to explain why for(;;) etc
    if (ForceSequential())
      break parallel;
    if (!TRY_PARALLEL(mode))
      break parallel;

    var chunks = ComputeNumChunks(length);
    var numSlices = ParallelSlices();
    if (chunks < numSlices)
      break parallel;

    var info = ComputeAllSliceBounds(chunks, numSlices);
    var subreductions = NewDenseArray(numSlices);
    ParallelDo(reduceSlice, CheckParallel(mode));
    var accumulator = subreductions[0];
    for (var i = 1; i < numSlices; i++)
      accumulator = func(accumulator, subreductions[i]);
    return accumulator;
  }

  // Sequential fallback:
  CHECK_SEQUENTIAL(mode);
  var accumulator = self.get(0);
  for (var i = 1; i < length; i++)
    accumulator = func(accumulator, self.get(i));
  return accumulator;

  function reduceSlice(sliceId, numSlices, warmup) {
    var chunkStart = info[SLICE_START(sliceId)];
    var chunkPos = info[SLICE_POS(sliceId)];
    var chunkEnd = info[SLICE_END(sliceId)];

    // (*) This function is carefully designed so that the warmup
    // (which executes with chunkStart === chunkPos) will execute
    // all potential loads and stores. In particular, the warmup run
    // processes two chunks rather than one.  Moreover, it stores accumulator
    // into subreductions and then loads it again ensure that the load
    // is executed during the warmup, as it will certainly be run
    // during subsequent runs.

    if (warmup && chunkEnd > chunkPos + 2)
      chunkEnd = chunkPos + 2;

    if (chunkStart === chunkPos) {
      var indexPos = chunkStart << CHUNK_SHIFT;
      var accumulator = reduceChunk(self.get(indexPos), indexPos + 1, indexPos + CHUNK_SIZE);

      UnsafeSetElement(subreductions, sliceId, accumulator, // see (*) above
                       info, SLICE_POS(sliceId), ++chunkPos);
    }

    var accumulator = subreductions[sliceId]; // see (*) above

    while (chunkPos < chunkEnd) {
      var indexPos = chunkPos << CHUNK_SHIFT;
      accumulator = reduceChunk(accumulator, indexPos, indexPos + CHUNK_SIZE);
      UnsafeSetElement(subreductions, sliceId, accumulator,
                       info, SLICE_POS(sliceId), ++chunkPos);
    }
  }

  function reduceChunk(accumulator, from, to) {
    to = std_Math_min(to, length);
    for (var i = from; i < to; i++)
      accumulator = func(accumulator, self.get(i));
    return accumulator;
  }
}

function ParallelArrayScan(func, mode) {
  var self = this;
  var length = self.shape[0];

  if (length === 0)
    ThrowError(JSMSG_PAR_ARRAY_REDUCE_EMPTY);

  var buffer = NewDenseArray(length);

  parallel: for (;;) { // see ParallelArrayBuild() to explain why for(;;) etc
    if (ForceSequential())
      break parallel;
    if (!TRY_PARALLEL(mode))
      break parallel;

    var chunks = ComputeNumChunks(length);
    var numSlices = ParallelSlices();
    if (chunks < numSlices)
      break parallel;
    var info = ComputeAllSliceBounds(chunks, numSlices);

    // Scan slices individually (see comment on phase1()).
    ParallelDo(phase1, CheckParallel(mode));

    // Compute intermediates array (see comment on phase2()).
    var intermediates = [];
    var accumulator = intermediates[0] = buffer[finalElement(0)];
    for (var i = 1; i < numSlices - 1; i++)
      accumulator = intermediates[i] = func(accumulator, buffer[finalElement(i)]);

    // Reset the current position information for each slice, but
    // convert from chunks to indicies (see comment on phase2()).
    for (var i = 0; i < numSlices; i++) {
      info[SLICE_POS(i)] = info[SLICE_START(i)] << CHUNK_SHIFT;
      info[SLICE_END(i)] = info[SLICE_END(i)] << CHUNK_SHIFT;
    }
    info[SLICE_END(numSlices - 1)] = std_Math_min(info[SLICE_END(numSlices - 1)], length);

    // Complete each slice using intermediates array (see comment on phase2()).
    ParallelDo(phase2, CheckParallel(mode));
    return NewParallelArray(ParallelArrayView, [length], buffer, 0);
  }

  // Sequential fallback:
  CHECK_SEQUENTIAL(mode);
  scan(self.get(0), 0, length);
  return NewParallelArray(ParallelArrayView, [length], buffer, 0);

  function scan(accumulator, start, end) {
    UnsafeSetElement(buffer, start, accumulator);
    for (var i = start + 1; i < end; i++) {
      accumulator = func(accumulator, self.get(i));
      UnsafeSetElement(buffer, i, accumulator);
    }
    return accumulator;
  }

  function phase1(sliceId, numSlices, warmup) {
    // In phase 1, we divide the source array into numSlices slices and
    // compute scan on each slice sequentially as it were the entire
    // array.  This function is responsible for computing one of those
    // slices.
    //
    // So, if we have an array [A,B,C,D,E,F,G,H,I], numSlices == 3, and our function
    // |f| is sum, then would wind up computing a result array like:
    //
    //     [A, A+B, A+B+C, D, D+E, D+E+F, G, G+H, G+H+I]
    //      ^~~~~~~~~~~~^  ^~~~~~~~~~~~^  ^~~~~~~~~~~~~^
    //      Slice 0        Slice 1        Slice 2
    //
    // Read on in phase2 to see what we do next!
    var chunkStart = info[SLICE_START(sliceId)];
    var chunkPos = info[SLICE_POS(sliceId)];
    var chunkEnd = info[SLICE_END(sliceId)];

    if (warmup && chunkEnd > chunkPos + 2)
      chunkEnd = chunkPos + 2;

    if (chunkPos == chunkStart) {
      // For the first chunk, the accumulator begins as the value in
      // the input at the start of the chunk.
      var indexStart = chunkPos << CHUNK_SHIFT;
      var indexEnd = std_Math_min(indexStart + CHUNK_SIZE, length);
      scan(self.get(indexStart), indexStart, indexEnd);
      UnsafeSetElement(info, SLICE_POS(sliceId), ++chunkPos);
    }

    while (chunkPos < chunkEnd) {
      // For each subsequent chunk, the accumulator begins as the
      // combination of the final value of prev chunk and the value in
      // the input at the start of this chunk.  Note that this loop is
      // written as simple as possible, at the cost of an extra read
      // from the buffer per iteration.
      var indexStart = chunkPos << CHUNK_SHIFT;
      var indexEnd = std_Math_min(indexStart + CHUNK_SIZE, length);
      var accumulator = func(buffer[indexStart - 1], self.get(indexStart));
      scan(accumulator, indexStart, indexEnd);
      UnsafeSetElement(info, SLICE_POS(sliceId), ++chunkPos);
    }
  }

  function finalElement(sliceId) {
    // Computes the index of the final element computed by the slice |sliceId|.
    var chunkEnd = info[SLICE_END(sliceId)]; // last chunk written by |sliceId| is endChunk - 1
    var indexStart = std_Math_min(chunkEnd << CHUNK_SHIFT, length);
    return indexStart - 1;
  }

  function phase2(sliceId, numSlices, warmup) {
    // After computing the phase1 results, we compute an
    // |intermediates| array.  |intermediates[i]| contains the result
    // of reducing the final value from each preceding slice j<i with
    // the final value of slice i.  So, to continue our previous
    // example, the intermediates array would contain:
    //
    //   [A+B+C, (A+B+C)+(D+E+F), ((A+B+C)+(D+E+F))+(G+H+I)]
    //
    // Here I have used parenthesization to make clear the order of
    // evaluation in each case.
    //
    //   An aside: currently the intermediates array is computed
    //   sequentially.  In principle, we could compute it in parallel,
    //   at the cost of doing duplicate work.  This did not seem
    //   particularly advantageous to me, particularly as the number
    //   of slices is typically quite small (one per core), so I opted
    //   to just compute it sequentially.
    //
    // Phase 2 combines the results of phase1 with the intermediates
    // array to produce the final scan results.  The idea is to
    // reiterate over each element S[i] in the slice |sliceId|, which
    // currently contains the result of reducing with S[0]...S[i]
    // (where S0 is the first thing in the slice), and combine that
    // with |intermediate[sliceId-1]|, which represents the result of
    // reducing everything in the input array prior to the slice.
    //
    // To continue with our example, in phase 1 we computed slice 1 to
    // be [D, D+E, D+E+F].  We will combine those results with
    // |intermediates[1-1]|, which is |A+B+C|, so that the final
    // result is [(A+B+C)+D, (A+B+C)+(D+E), (A+B+C)+(D+E+F)].  Again I
    // am using parentheses to clarify how these results were reduced.
    //
    // SUBTLE: Because we are mutating |buffer| in place, we have to
    // be very careful about bailouts!  We cannot checkpoint a chunk
    // at a time as we do elsewhere because that assumes it is safe to
    // replay the portion of a chunk which was already processed.
    // Therefore, in this phase, we track the current position at an
    // index granularity, although this requires two memory writes per
    // index.

    if (sliceId == 0)
      return; // No work to do for the 0th slice.

    var indexPos = info[SLICE_POS(sliceId)];
    var indexEnd = info[SLICE_END(sliceId)];

    if (warmup)
      indexEnd = std_Math_min(indexEnd, indexPos + CHUNK_SIZE);

    var intermediate = intermediates[sliceId - 1];
    for (; indexPos < indexEnd; indexPos++)
      UnsafeSetElement(buffer, indexPos, func(intermediate, buffer[indexPos]),
                       info, SLICE_POS(sliceId), indexPos + 1);
  }
}

function ParallelArrayScatter(targets, zero, func, length, mode) {

  var self = this;

  if (length === undefined)
    length = self.shape[0];

  // The Divide-Scatter-Vector strategy:
  // 1. Slice |targets| array of indices ("scatter-vector") into N
  //    parts.
  // 2. Each of the N threads prepares an output buffer and a
  //    write-log.
  // 3. Each thread scatters according to one of the N parts into its
  //    own output buffer, tracking written indices in the write-log
  //    and resolving any resulting local collisions in parallel.
  // 4. Merge the parts (either in parallel or sequentially), using
  //    the write-logs as both the basis for finding merge-inputs and
  //    for detecting collisions.

  // The Divide-Output-Range strategy:
  // 1. Slice the range of indices [0..|length|-1] into N parts.
  //    Allocate a single shared output buffer of length |length|.
  // 2. Each of the N threads scans (the entirety of) the |targets|
  //    array, seeking occurrences of indices from that thread's part
  //    of the range, and writing the results into the shared output
  //    buffer.
  // 3. Since each thread has its own portion of the output range,
  //    every collision that occurs can be handled thread-locally.

  // SO:
  //
  // If |targets.length| >> |length|, Divide-Scatter-Vector seems like
  // a clear win over Divide-Output-Range, since for the latter, the
  // expense of redundantly scanning the |targets| will diminish the
  // gain from processing |length| in parallel, while for the former,
  // the total expense of building separate output buffers and the
  // merging post-process is small compared to the gain from
  // processing |targets| in parallel.
  //
  // If |targets.length| << |length|, then Divide-Output-Range seems
  // like it *could* win over Divide-Scatter-Vector.  (But when is
  // |targets.length| << |length| or even |targets.length| < |length|?
  // Seems like an odd situation and an uncommon case at best.)
  //
  // The unanswered question is which strategy performs better when
  // |targets.length| approximately equals |length|, especially for
  // special cases like collision-free scatters and permutations.

  if (targets.length >>> 0 !== targets.length)
    ThrowError(JSMSG_BAD_ARRAY_LENGTH, "");

  var targetsLength = std_Math_min(targets.length, self.length);

  if (length && length >>> 0 !== length)
    ThrowError(JSMSG_BAD_ARRAY_LENGTH, "");

  parallel: for (;;) { // see ParallelArrayBuild() to explain why for(;;) etc
    if (ForceSequential())
      break parallel;
    if (!TRY_PARALLEL(mode))
      break parallel;

    if (forceDivideScatterVector())
      return parDivideScatterVector();
    else if (forceDivideOutputRange())
      return parDivideOutputRange();
    else if (func === undefined && targetsLength < length)
      return parDivideOutputRange();
    return parDivideScatterVector();
  }

  // Sequential fallback:
  CHECK_SEQUENTIAL(mode);
  return seq();

  function forceDivideScatterVector() {
    return mode && mode.strategy && mode.strategy == "divide-scatter-vector";
  }

  function forceDivideOutputRange() {
    return mode && mode.strategy && mode.strategy == "divide-output-range";
    return func(elem1, elem2);
  }

  function collide(elem1, elem2) {
    if (func === undefined)
      ThrowError(JSMSG_PAR_ARRAY_SCATTER_CONFLICT);

    return func(elem1, elem2);
  }


  function parDivideOutputRange() {
    var chunks = ComputeNumChunks(targetsLength);
    var numSlices = ParallelSlices();
    var checkpoints = NewDenseArray(numSlices);
    for (var i = 0; i < numSlices; i++)
      checkpoints[i] = 0;

    var buffer = NewDenseArray(length);
    var conflicts = NewDenseArray(length);

    for (var i = 0; i < length; i++)
      buffer[i] = zero;

    ParallelDo(fill, CheckParallel(mode));
    return NewParallelArray(ParallelArrayView, [length], buffer, 0);

    function fill(sliceId, numSlices, warmup) {
      var indexPos = checkpoints[sliceId];
      var indexEnd = targetsLength;
      if (warmup)
        indexEnd = std_Math_min(indexEnd, indexPos + CHUNK_SIZE);

      // Range in the output for which we are responsible:
      var [outputStart, outputEnd] = ComputeSliceBounds(length, sliceId, numSlices);

      for (; indexPos < indexEnd; indexPos++) {
        var x = self.get(indexPos);
        var t = targets[indexPos];
        checkTarget(t);
        if (t < outputStart || t >= outputEnd)
          continue;
        if (conflicts[t])
          x = collide(x, buffer[t]);
        UnsafeSetElement(buffer, t, x,
                         conflicts, t, true,
                         checkpoints, sliceId, indexPos + 1);
      }
    }
  }

  function parDivideScatterVector() {
    // Subtle: because we will be mutating the localbuffers and
    // conflict arrays in place, we can never replay an entry in the
    // target array for fear of inducing a conflict where none existed
    // before.  Therefore, we must proceed not by chunks but rather by
    // individual indices,
    var numSlices = ParallelSlices();
    var info = ComputeAllSliceBounds(targetsLength, numSlices);

    var localbuffers = NewDenseArray(numSlices);
    for (var i = 0; i < numSlices; i++)
        localbuffers[i] = NewDenseArray(length);
    var localconflicts = NewDenseArray(numSlices);
    for (var i = 0; i < numSlices; i++)
        localconflicts[i] = NewDenseArray(length);

    // Initialize the 0th buffer, which will become the output.  For
    // the other buffers, we track which parts have been written to
    // using the conflict buffer so they do not need to be
    // initialized.
    var outputbuffer = localbuffers[0];
    for (var i = 0; i < length; i++)
      outputbuffer[i] = zero;

    ParallelDo(fill, CheckParallel(mode));
    mergeBuffers();
    return NewParallelArray(ParallelArrayView, [length], outputbuffer, 0);

    function fill(sliceId, numSlices, warmup) {
      var indexPos = info[SLICE_POS(sliceId)];
      var indexEnd = info[SLICE_END(sliceId)];
      if (warmup)
        indexEnd = std_Math_min(indexEnd, indexPos + CHUNK_SIZE);

      var localbuffer = localbuffers[sliceId];
      var conflicts = localconflicts[sliceId];
      while (indexPos < indexEnd) {
        var x = self.get(indexPos);
        var t = targets[indexPos];
        checkTarget(t);
        if (conflicts[t])
          x = collide(x, localbuffer[t]);
        UnsafeSetElement(localbuffer, t, x,
                         conflicts, t, true,
                         info, SLICE_POS(sliceId), ++indexPos);
      }
    }

    function mergeBuffers() {
      // Merge buffers 1..NUMSLICES into buffer 0.  In principle, we could
      // parallelize the merge work as well.  But for this first cut,
      // just do the merge sequentially.
      var buffer = localbuffers[0];
      var conflicts = localconflicts[0];
      for (var i = 1; i < numSlices; i++) {
        var otherbuffer = localbuffers[i];
        var otherconflicts = localconflicts[i];
        for (var j = 0; j < length; j++) {
          if (otherconflicts[j]) {
            if (conflicts[j]) {
              buffer[j] = collide(otherbuffer[j], buffer[j]);
            } else {
              buffer[j] = otherbuffer[j];
              conflicts[j] = true;
            }
          }
        }
      }
    }
  }

  function seq() {
    var buffer = NewDenseArray(length);
    var conflicts = NewDenseArray(length);

    for (var i = 0; i < length; i++)
      buffer[i] = zero;

    for (var i = 0; i < targetsLength; i++) {
      var x = self.get(i);
      var t = targets[i];
      checkTarget(t);
      if (conflicts[t])
        x = collide(x, buffer[t]);

      UnsafeSetElement(buffer, t, x,
                       conflicts, t, true);
    }

    return NewParallelArray(ParallelArrayView, [length], buffer, 0);
  }

  function checkTarget(t) {
      if ((t | 0) !== t)
        ThrowError(JSMSG_PAR_ARRAY_BAD_ARG, ".prototype.scatter");

      if (t >= length)
        ThrowError(JSMSG_PAR_ARRAY_SCATTER_BOUNDS);
  }
}

function ParallelArrayFilter(func, mode) {
  var self = this;
  var length = self.shape[0];

  parallel: for (;;) { // see ParallelArrayBuild() to explain why for(;;) etc
    if (ForceSequential())
      break parallel;
    if (!TRY_PARALLEL(mode))
      break parallel;

    var chunks = ComputeNumChunks(length);
    var numSlices = ParallelSlices();
    if (chunks < numSlices * 2)
      break parallel;

    var info = ComputeAllSliceBounds(chunks, numSlices);

    // Step 1.  Compute which items from each slice of the result
    // buffer should be preserved.  When we're done, we have an array
    // |survivors| containing a bitset for each chunk, indicating
    // which members of the chunk survived.  We also keep an array
    // |counts| containing the total number of items that are being
    // preserved from within one slice.
    var counts = NewDenseArray(numSlices);
    for (var i = 0; i < numSlices; i++)
      counts[i] = 0;
    var survivors = NewDenseArray(chunks);
    ParallelDo(findSurvivorsInSlice, CheckParallel(mode));

    // Step 2. Compress the slices into one contiguous set.
    var count = 0;
    for (var i = 0; i < numSlices; i++)
      count += counts[i];
    var buffer = NewDenseArray(count);
    if (count > 0)
      ParallelDo(copySurvivorsInSlice, CheckParallel(mode));

    return NewParallelArray(ParallelArrayView, [count], buffer, 0);
  }

  // Sequential fallback:
  CHECK_SEQUENTIAL(mode);
  var buffer = [], count = 0;
  for (var i = 0; i < length; i++) {
    var elem = self.get(i);
    if (func(elem, i, self))
      buffer[count++] = elem;
  }
  return NewParallelArray(ParallelArrayView, [count], buffer, 0);

  function findSurvivorsInSlice(sliceId, numSlices, warmup) {
    // As described above, our goal is to determine which items we
    // will preserve from a given slice.  We do this one chunk at a
    // time. When we finish a chunk, we record our current count and
    // the next chunk sliceId, lest we should bail.

    var chunkPos = info[SLICE_POS(sliceId)];
    var chunkEnd = info[SLICE_END(sliceId)];

    if (warmup && chunkEnd > chunkPos)
      chunkEnd = chunkPos + 1;

    var count = counts[sliceId];
    while (chunkPos < chunkEnd) {
      var indexStart = chunkPos << CHUNK_SHIFT;
      var indexEnd = std_Math_min(indexStart + CHUNK_SIZE, length);
      var chunkBits = 0;

      for (var bit = 0; indexStart + bit < indexEnd; bit++) {
        var keep = !!func(self.get(indexStart + bit), indexStart + bit, self);
        chunkBits |= keep << bit;
        count += keep;
      }

      UnsafeSetElement(survivors, chunkPos, chunkBits,
                       counts, sliceId, count,
                       info, SLICE_POS(sliceId), ++chunkPos);
    }
  }

  function copySurvivorsInSlice(sliceId, numSlices, warmup) {
    // Copies the survivors from this slice into the correct position.
    // Note that this is an idempotent operation that does not invoke
    // user code.  Therefore, we don't expect bailouts and make an
    // effort to proceed chunk by chunk or avoid duplicating work.

    // During warmup, we only execute with sliceId 0.  This would fail to
    // execute the loop below.  Therefore, during warmup, we
    // substitute 1 for the sliceId.
    if (warmup && sliceId == 0 && numSlices != 1)
      sliceId = 1;

    // Total up the items preserved by previous slices.
    var count = 0;
    if (sliceId > 0) { // FIXME(#819219)---work around a bug in Ion's range checks
      for (var i = 0; i < sliceId; i++)
        count += counts[i];
    }

    // Compute the final index we expect to write.
    var total = count + counts[sliceId];
    if (count == total)
      return;

    // Iterate over the chunks assigned to us. Read the bitset for
    // each chunk.  Copy values where a 1 appears until we have
    // written all the values that we expect to.  We can just iterate
    // from 0...CHUNK_SIZE without fear of a truncated final chunk
    // because we are already checking for when count==total.
    var chunkStart = info[SLICE_START(sliceId)];
    var chunkEnd = info[SLICE_END(sliceId)];
    for (var chunk = chunkStart; chunk < chunkEnd; chunk++) {
      var chunkBits = survivors[chunk];
      var indexStart = chunk << CHUNK_SHIFT;
      for (var i = 0; i < CHUNK_SIZE; i++) {
        if (chunkBits & (1 << i)) {
          UnsafeSetElement(buffer, count++, self.get(indexStart + i));
          if (count == total)
            break;
        }
      }
    }
  }
}

function ParallelArrayPartition(amount) {
  if (amount >>> 0 !== amount)
    ThrowError(JSMSG_BAD_ARRAY_LENGTH, ""); // XXX

  var length = this.shape[0];
  var partitions = (length / amount) | 0;

  if (partitions * amount !== length)
    ThrowError(JSMSG_BAD_ARRAY_LENGTH, ""); // XXX

  var shape = [partitions, amount];
  for (var i = 1; i < this.shape.length; i++)
    shape.push(this.shape[i]);
  return NewParallelArray(ParallelArrayView, shape, this.buffer, this.offset);
}

function ParallelArrayFlatten() {
  if (this.shape.length < 2)
    ThrowError(JSMSG_BAD_ARRAY_LENGTH, ""); // XXX

  var shape = [this.shape[0] * this.shape[1]];
  for (var i = 2; i < this.shape.length; i++)
    shape.push(this.shape[i]);
  return NewParallelArray(ParallelArrayView, shape, this.buffer, this.offset);
}

//
// Accessors and utilities.
//

function ParallelArrayGet1(i) {
  if (i === undefined)
    return undefined;
  return this.buffer[this.offset + i];
}

function ParallelArrayGet2(x, y) {
  var xDimension = this.shape[0];
  var yDimension = this.shape[1];
  if (x === undefined)
    return undefined;
  if (x >= xDimension)
    return undefined;
  if (y === undefined)
    return NewParallelArray(ParallelArrayView, [yDimension], this.buffer, this.offset + x*yDimension);
  if (y >= yDimension)
    return undefined;
  var offset = y + x*yDimension;
  return this.buffer[this.offset + offset];
}

function ParallelArrayGet3(x, y, z) {
  var xDimension = this.shape[0];
  var yDimension = this.shape[1];
  var zDimension = this.shape[2];
  if (x === undefined)
    return undefined;
  if (x >= xDimension)
    return undefined;
  if (y === undefined)
    return NewParallelArray(ParallelArrayView, [yDimension, zDimension],
                            this.buffer, this.offset + x*yDimension*zDimension);
  if (y >= yDimension)
    return undefined;
  if (z === undefined)
    return NewParallelArray(ParallelArrayView, [zDimension],
                            this.buffer, this.offset + y*zDimension + x*yDimension*zDimension);
  if (z >= zDimension)
    return undefined;
  var offset = z + y*zDimension + x*yDimension*zDimension;
  return this.buffer[this.offset + offset];
}

function ParallelArrayGetN(...coords) {
  if (coords.length == 0)
    return undefined;

  var products = ComputeProducts(this.shape);

  // Compute the offset of the given coordinates.  Each index is
  // multipled by its corresponding entry in the |products|
  // array, counting in reverse.  So if |coords| is [a,b,c,d],
  // then you get |a*BCD + b*CD + c*D + d|.
  var offset = this.offset;
  var sdimensionality = this.shape.length;
  var cdimensionality = coords.length;
  for (var i = 0; i < cdimensionality; i++) {
    if (coords[i] >= this.shape[i])
      return undefined;
    offset += coords[i] * products[sdimensionality - i - 1];
  }

  if (cdimensionality < sdimensionality) {
    var shape = this.shape.slice(cdimensionality);
    return NewParallelArray(ParallelArrayView, shape, this.buffer, offset);
  }
  return this.buffer[offset];
}

function ParallelArrayLength() {
  return this.shape[0];
}

function ParallelArrayToString() {
  var l = this.shape[0];
  if (l == 0)
    return "";

  var open, close;
  if (this.shape.length > 1) {
    open = "<"; close = ">";
  } else {
    open = close = "";
  }

  var result = "";
  for (var i = 0; i < l - 1; i++) {
    result += open + String(this.get(i)) + close;
    result += ",";
  }
  result += open + String(this.get(l-1)) + close;
  return result;
}

function CheckSequential(mode) {
  if (!mode || mode.mode === "seq")
    return;

  ThrowError(JSMSG_WRONG_VALUE, "par", "seq");
}

function CheckParallel(mode) {
  if (!mode || !ParallelTestsShouldPass())
    return null;

  return function(bailouts) {
    if (!("expect" in mode) || mode.expect === "any") {
      return; // Ignore result when unspecified or unimportant.
    }

    var result;
    if (bailouts === 0)
      result = "success";
    else if (bailouts === global.Infinity)
      result = "disqualified";
    else
      result = "bailout";

    if (mode.expect === "mixed") {
      if (result !== "success" && result !== "bailout")
        ThrowError(JSMSG_WRONG_VALUE, mode.expect, result);
    } else if (result !== mode.expect) {
      ThrowError(JSMSG_WRONG_VALUE, mode.expect, result);
    }
  };
}

// Mark the main operations as clone-at-callsite for better precision.
SetScriptHints(ParallelArrayConstruct0, { cloneAtCallsite: true });
SetScriptHints(ParallelArrayConstruct1, { cloneAtCallsite: true });
SetScriptHints(ParallelArrayConstruct2, { cloneAtCallsite: true });
SetScriptHints(ParallelArrayConstruct3, { cloneAtCallsite: true });
SetScriptHints(ParallelArrayView,       { cloneAtCallsite: true });
SetScriptHints(ParallelArrayBuild,      { cloneAtCallsite: true });
SetScriptHints(ParallelArrayMap,        { cloneAtCallsite: true });
SetScriptHints(ParallelArrayReduce,     { cloneAtCallsite: true });
SetScriptHints(ParallelArrayScan,       { cloneAtCallsite: true });
SetScriptHints(ParallelArrayScatter,    { cloneAtCallsite: true });
SetScriptHints(ParallelArrayFilter,     { cloneAtCallsite: true });

// Mark the common getters as clone-at-callsite.
SetScriptHints(ParallelArrayGet1,       { cloneAtCallsite: true });
SetScriptHints(ParallelArrayGet2,       { cloneAtCallsite: true });
SetScriptHints(ParallelArrayGet3,       { cloneAtCallsite: true });

// Unit Test Functions
//
// function CheckIndices(shape, index1d) {
//   let idx = ComputeIndices(shape, index1d);
//
//   let c = 0;
//   for (var i = 0; i < shape.length; i++) {
//     var stride = 1;
//     for (var j = i + 1; j < shape.length; j++) {
//       stride *= shape[j];
//     }
//     c += idx[i] * stride;
//   }
//
//   assertEq(index1d, c);
// }
//
// for (var q = 0; q < 2*4*6*8; q++) {
//   CheckIndices([2,4,6,8], q);
// }
