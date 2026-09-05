(function ($, window, Typist) {
    
	
	// Dropdown Menu Fade    
	jQuery(document).ready(function(){
		$(".dropdown").hover(
			function() { $('.dropdown-menu', this).fadeIn("fast");
			},
			function() { $('.dropdown-menu', this).fadeOut("fast");
		});
	});
	
	/*-------active---------*/
	
	$(document).ready(function() {
		$(".nav-link").click(function () {
			$(".nav-link").removeClass("active");
			$(this).addClass("active");   
		});
	});
	
	
	/*-------------headder_fixed-------------*/
	
	
		// $(window).scroll(function(){
		// 	var sticky = $('.header'),
		// 		scroll = $(window).scrollTop();
		  
		// 	if (scroll >= 20) sticky.addClass('fixed');
		// 	else sticky.removeClass('fixed');
		// });
	
/*--------------ASO.JS---------------*/
	
  AOS.init();
		
 //refresh animations
 
  $(window).on('load', function() {
  	AOS.refresh();
  });

/*---------banner_slide----------*/

var swiper = new Swiper(".bannerSlide", {
	autoplay: {
		delay: 1500,
		disableOnInteraction: true,
	},
	pagination: {
	  el: ".swiper-pagination",
	  clickable: true,
	  renderBullet: function (index, className) {
		return '<span class="' + className + '">' + (index + 1) + "</span>";
	  },
	},
});

// var swiper = new Swiper(".providerSlide", {
// 	slidesPerView: 3,
// 	spaceBetween: 30,
// 	pagination: {
// 	  el: ".swiper-pagination",
// 	  clickable: true,
// 	},
// });
var swiper = new Swiper(".campaign_img_slider", {
	loop: false,
	spaceBetween: 10,
	slidesPerView: 1,
  autoplay: {
    delay: 1500,
    disableOnInteraction: false,
  },
  pagination: {
    el: ".swiper-pagination",
    clickable: true,
  },
});

var swiper = new Swiper(".slide-box-img-slider", {
	loop: false,
	spaceBetween: 30,
	slidesPerView: 2,
  autoplay: {
    delay: 1500,
    disableOnInteraction: false,
  },
  pagination: {
    el: ".swiper-pagination",
    clickable: true,
  },
});

var swiper = new Swiper(".catalog_items", {
	loop: false,
	spaceBetween: 80,
	slidesPerView: 4,
  autoplay: {
    delay: 1500,
    disableOnInteraction: false,
  },
  pagination: {
    el: ".swiper-pagination",
    clickable: true,
  },
  breakpoints: {
    320: {
      slidesPerView: 2,
      spaceBetween: 20,
    },
    636: {
      slidesPerView: 4,
      spaceBetween: 20,
    },
    768: {
      slidesPerView: 4,
      spaceBetween: 40,
    },
    1024: {
      slidesPerView: 4,
      spaceBetween: 80,
    },
  },
});

var swiper = new Swiper(".catalog_items-mod", {
	loop: false,
  direction: "vertical",
	spaceBetween: 0,
	slidesPerView: 3,
  autoplay: {
    delay: 1500,
    disableOnInteraction: false,
  },
  breakpoints: {
    320: {
      slidesPerView: 2,
      spaceBetween: 20,
      direction: "horizontal",
    },
    636: {
      slidesPerView: 3,
      spaceBetween: 20,
      direction: "vertical",
    },
  },
});

var swiper = new Swiper(".pdSlide1", {
	loop: false,
	spaceBetween: 10,
	slidesPerView: 4,
	freeMode: true,
	watchSlidesProgress: true,
});
var swiper2 = new Swiper(".pdSlide2", {
	loop: false,
	spaceBetween: 10,
	navigation: {
	  nextEl: ".swiper-button-next",
	  prevEl: ".swiper-button-prev",
	},
	thumbs: {
	  swiper: swiper,
	},
});
var swiper = new Swiper(".lifestyle-slider", {
  slidesPerView: 4,
  spaceBetween: 30,
  loop: true,
  centeredSlides: false,
  autoplay: {
      delay: 2500,
      disableOnInteraction: false,
  },
  pagination: {
  el: ".swiper-pagination",
  clickable: true,
  },
});

/*------------------megamenu------------------*/

document.addEventListener("DOMContentLoaded", function(){
	/////// Prevent closing from click inside dropdown
	document.querySelectorAll('.dropdown-menu').forEach(function(element){
		element.addEventListener('click', function (e) {
			e.stopPropagation();
		});
	})
}); 

/*-------------quantity---------------*/

$('.add').click(function () {		
	var th = $(this).closest('.wrap').find('.count');    	
	th.val(+th.val() + 1);
  });
  $('.sub').click(function () {
	var th = $(this).closest('.wrap').find('.count');    	
		  if (th.val() > 1) th.val(+th.val() - 1);
});


/*-----------Ligh_box--------------*/


$( ".img-wrapper" ).hover(
  function() {
    $(this).find(".img-overlay").animate({opacity: 1}, 600);
  }, function() {
    $(this).find(".img-overlay").animate({opacity: 0}, 600);
  }
);

// Lightbox
var $overlay = $('<div id="overlay"></div>');
var $image = $("<img>");
var $prevButton = $('<div id="prevButton"><i data-feather="arrow-left-circle"></i></div>');
var $nextButton = $('<div id="nextButton"><i data-feather="arrow-right-circle"></i></div>');
var $exitButton = $('<div id="exitButton"><i data-feather="x-circle"></i></div>');

// Add overlay
$overlay.append($image).prepend($prevButton).append($nextButton).append($exitButton);
$("#gallery").append($overlay);

// Hide overlay on default
$overlay.hide();

// When an image is clicked
$(".img-overlay").click(function(event) {
  // Prevents default behavior
  event.preventDefault();
  // Adds href attribute to variable
  var imageLocation = $(this).prev().attr("href");
  // Add the image src to $image
  $image.attr("src", imageLocation);
  // Fade in the overlay
  $overlay.fadeIn("slow");
});

// When the overlay is clicked
$overlay.click(function() {
  // Fade out the overlay
  $(this).fadeOut("slow");
});

// When next button is clicked
$nextButton.click(function(event) {
  // Hide the current image
  $("#overlay img").hide();
  // Overlay image location
  var $currentImgSrc = $("#overlay img").attr("src");
  // Image with matching location of the overlay image
  var $currentImg = $('#image-gallery img[src="' + $currentImgSrc + '"]');
  // Finds the next image
  var $nextImg = $($currentImg.closest(".image").next().find("img"));
  // All of the images in the gallery
  var $images = $("#image-gallery img");
  // If there is a next image
  if ($nextImg.length > 0) { 
    // Fade in the next image
    $("#overlay img").attr("src", $nextImg.attr("src")).fadeIn(800);
  } else {
    // Otherwise fade in the first image
    $("#overlay img").attr("src", $($images[0]).attr("src")).fadeIn(800);
  }
  // Prevents overlay from being hidden
  event.stopPropagation();
});

// When previous button is clicked
$prevButton.click(function(event) {
  // Hide the current image
  $("#overlay img").hide();
  // Overlay image location
  var $currentImgSrc = $("#overlay img").attr("src");
  // Image with matching location of the overlay image
  var $currentImg = $('#image-gallery img[src="' + $currentImgSrc + '"]');
  // Finds the next image
  var $nextImg = $($currentImg.closest(".image").prev().find("img"));
  // Fade in the next image
  $("#overlay img").attr("src", $nextImg.attr("src")).fadeIn(800);
  // Prevents overlay from being hidden
  event.stopPropagation();
});

// When the exit button is clicked
$exitButton.click(function() {
  // Fade out the overlay
  $("#overlay").fadeOut("slow");
});

$(document).ready(function(){

    $(".filter-button").click(function(){
        var value = $(this).attr('data-filter');
        
        if(value == "all")
        {
            //$('.filter').removeClass('hidden');
            $('.filter').show('1000');
        }
        else
        {
//            $('.filter[filter-item="'+value+'"]').removeClass('hidden');
//            $(".filter").not('.filter[filter-item="'+value+'"]').addClass('hidden');
            $(".filter").not('.'+value).hide('3000');
            $('.filter').filter('.'+value).show('3000');
            
        }
    });
    
    if ($(".filter-button").removeClass("active")) {
$(this).removeClass("active");
}
$(this).addClass("active");

});


/*----------------------------*/

// Show the first tab and hide the rest
$('#tabs-nav li:first-child').addClass('active');
$('.tab-content').hide();
$('.tab-content:first').show();

// Click function
$('#tabs-nav li').click(function(){
  $('#tabs-nav li').removeClass('active');
  $(this).addClass('active');
  $('.tab-content').hide();
  
  var activeTab = $(this).find('a').attr('href');
  $(activeTab).fadeIn();
  return false;
});



$('#v-pills-tab button:first-child').addClass('active');
$('.tab-pane:first-child').addClass('show active');

// Click function
$('#v-pills-tab button').click(function(){
  $('#v-pills-tab button').removeClass('active');
  $(this).addClass('active');
  //$('.tab-pane').removeClass('show active');
  
  var showTab = $(this).find('a').attr('data-bs-target');
  $(showTab).addClass('show active');

  //var targetBox = $("." + showTab);
  $(".tab-pane").not(targetBox).removeClass('show active');
  $(targetBox).addClass('show active');
  return false;
});




// Show the first tab and hide the rest
$('#tabs-nav2 li:first-child').addClass('active');
$('.tab-content2').hide();
$('.tab-content2:first').show();

// Click function
$('#tabs-nav2 li').click(function(){
  $('#tabs-nav2 li').removeClass('active');
  $(this).addClass('active');
  $('.tab-content2').hide();
  
  var activeTab = $(this).find('a').attr('href');
  $(activeTab).fadeIn();
  return false;
});

})(jQuery, window);



